/* Twilio Voice SDK integration for Frappe (v2.2.0)
 * - Loads SDK safely
 * - Uses v2 Device + Call APIs
 * - Preserves your dialogs/dialpad/notes workflow
 */

var con;                   // latest active Call (Twilio Call object)
var call_start = 0;
let def = "";

/* -----------------------------------------------------------
   1) Load Twilio SDK v2.2.0 first, then initialize
----------------------------------------------------------- */
$(document).ready(() => {
  console.log("[Twilio] Desk ready. Injecting Twilio SDK v2.2.0...");

  const script = document.createElement("script");
  script.src = "/assets/twilio_integration/js/twilio.min.js";
  script.type = "text/javascript";
  script.async = true;

  script.onload = () => {
    console.log("[Twilio] SDK loaded. Initializing...");
    // Support both globals: Device (v2 UMD) and Twilio.Device (older expectation)
    const DeviceCtor = window.Device || (window.Twilio && window.Twilio.Device);
    if (!DeviceCtor) {
      console.error("[Twilio] Neither global Device nor Twilio.Device is available.");
      return;
    }
    try {
      onload_script(DeviceCtor);
    } catch (err) {
      console.error("[Twilio] onload_script failed:", err);
    }
  };

  script.onerror = () => {
    console.error("[Twilio] Failed to load Voice SDK from CDN.");
  };

  document.head.appendChild(script);
});

/* -----------------------------------------------------------
   2) Globals & helpers used across handlers
----------------------------------------------------------- */

// Robust map Call <-> Popup (avoid using objects as keys)
const _popupByCallId = Object.create(null);
function _idForCall(call) {
  if (!call.__popupId) call.__popupId = "call_" + Math.random().toString(36).slice(2);
  return call.__popupId;
}
function linkPopup(call, popup) {
  _popupByCallId[_idForCall(call)] = popup;
}
function getPopup(call) {
  return _popupByCallId[_idForCall(call)];
}
function unlinkPopup(call) {
  delete _popupByCallId[_idForCall(call)];
}

/* -----------------------------------------------------------
   3) Main init
----------------------------------------------------------- */
var onload_script = function (DeviceCtor) {
  console.log("[Twilio] Entered onload_script()");

  frappe.provide("frappe.phone_call");
  frappe.provide("frappe.twilio_conn_dialog_map"); // kept for legacy compatibility (iterated on 'registered')

  let device;

  if (!frappe.boot || !frappe.boot.twilio_enabled) {
    console.warn("[Twilio] frappe.boot.twilio_enabled is falsey; skipping init.");
    return;
  }

  frappe.run_serially([
    () => setup_device(),
    () => dialer_screen()
  ]);

  /* -------------------- Device setup -------------------- */
  function setup_device() {
    console.log("[Twilio] Getting access token...");
    frappe.call({
      method: "twilio_integration.twilio_integration.api.generate_access_token",
      callback: (data) => {
        if (!data.message || !data.message.token) {
          console.error("[Twilio] No token returned from server.");
          return;
        }

        try {
          // Create Device (v2)
          device = new DeviceCtor(data.message.token, {
            // You can add options here (e.g., codecPreferences)
            // logLevel: "error",
          });
          console.log("[Twilio] Device created.");
        } catch (e) {
          console.error("[Twilio] Device constructor failed:", e);
          return;
        }

        // Register for incoming, presence, etc.
        // (In v2, Device does not open signaling channel until register() or connect())
        try {
          device.register();
          console.log("[Twilio] Device.register() called.");
        } catch (e) {
          console.error("[Twilio] Device.register() failed:", e);
        }

        // ---- Token auto-refresh ----
        device.on("tokenWillExpire", () => {
          console.log("[Twilio] Token expiring; refreshing...");
          frappe.call({
            method: "twilio_integration.twilio_integration.api.generate_access_token",
            callback: (res) => {
              if (res.message && res.message.token) {
                try {
                  device.updateToken(res.message.token);
                  console.log("[Twilio] Token updated.");
                } catch (e) {
                  console.error("[Twilio] updateToken failed:", e);
                }
              } else {
                console.error("[Twilio] Token refresh endpoint did not return a token.");
              }
            }
          });
        });

        // ---- Device lifecycle/events ----
        device.on("registered", () => {
          console.log("[Twilio] Device registered.");
          // Keep compatibility with your earlier loop:
          Object.values(_popupByCallId).forEach((popup) => {
            popup?.set_header?.("available");
          });
        });

        device.on("unregistered", () => {
          console.warn("[Twilio] Device unregistered.");
        });

        device.on("error", (error) => {
          console.error("[Twilio] Device error:", error);
          Object.values(_popupByCallId).forEach((popup) => popup?.set_header?.("Failed"));
          try {
            device.disconnectAll();
          } catch (_) { /* ignore */ }
        });

        device.on("incoming", (call) => {
          // mark as incoming for UI logic on disconnect
          call.__incoming = true;
          console.log("[Twilio] Incoming call from:", call.parameters && call.parameters.From);
          call_screen(call);
        });
      }
    });
  }

  /* -------------------- Dialer (outgoing) -------------------- */
  function dialer_screen() {
    frappe.phone_call.handler = (to_number /* string | string[] */, frm) => {
      let to_numbers = Array.isArray(to_number) ? to_number : String(to_number || "").split("\n");
      const popup = new OutgoingCallPopup(device, to_numbers);
      popup.show();
    };
  }

  /* -------------------- Call Log update -------------------- */
  function update_call_log(call, status = "Completed") {
    con = call;
    const sid = call?.parameters?.CallSid; // Client leg SID
    if (!sid) return;
    frappe.call({
      method: "twilio_integration.twilio_integration.api.update_call_log",
      args: { call_sid: sid, status }
    });
  }

  /* -------------------- Incoming Call Screen -------------------- */
  function call_screen(call) {
    con = call;
    const from = (call.parameters && call.parameters.From) || "";
    frappe.call({
      type: "GET",
      method: "twilio_integration.twilio_integration.api.get_contact_details",
      args: { phone: from },
      callback: (data) => {
        const incoming_popup = new IncomingCallPopup(device, call);
        incoming_popup.show(data.message);
        wire_call_events(call, incoming_popup);
      }
    });
  }

  /* -------------------- Call -> UI wiring (shared) -------------------- */
  function wire_call_events(call, popup) {
    linkPopup(call, popup);

    // Ringing state
    call.on("ringing", () => {
      popup.set_header("ringing");
      call_start = 1;
    });

    // When call is accepted (i.e., media connected)
    call.on("accept", () => {
      popup.setup_mute_button(call);
      popup.dialog.set_secondary_action_label("Hang Up");
      popup.set_header("in-progress");

      window.onbeforeunload = function () {
        return "You cannot refresh the page during a call.";
      };

      popup.setup_dial_icon();
      popup.setup_dialpad(call);

      // Keyboard DTMF (only if dialpad visible)
      document.onkeydown = (e) => {
        if (popup.dialog.$wrapper.find(".dialpad-section").is(":hidden")) return;
        const key = e.key;
        if (["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "w"].includes(key)) {
          try {
            call.sendDigits(key);
            popup.update_dialpad_input(key);
          } catch (_) { /* ignore */ }
        }
      };
    });

    // Disconnect cleanup
    call.on("disconnect", () => {
      update_call_log(call);

      const p = getPopup(call);
      unlinkPopup(call);

      if (p) {
        p.dialog.enable_primary_action?.();
        p.show_close_button?.();
        window.onbeforeunload = null;
        p.set_header?.("available");
        p.hide_mute_button?.();
        p.hide_hangup_button?.();
        p.hide_dial_icon?.();
        p.hide_dialpad?.();
        if (call.__incoming) {
          p.close?.();
        }
      }
    });

    call.on("error", (err) => {
      console.error("[Twilio] Call error:", err);
      const p = getPopup(call);
      p?.set_header?.("Failed");
    });
  }

  /* ===========================================================
     UI helpers & classes
  =========================================================== */

  async function change_status_complete(sell_type) {
    let fields = [
      { label: "Call Rating", fieldname: "call_rating", fieldtype: "Rating" },
      { label: "Request Call Review", fieldname: "request_call_review", fieldtype: "Check" },
      { fieldname: "cb1", fieldtype: "Column Break" },
      { label: "Reviewer", fieldname: "reviewer", fieldtype: "Link", options: "User" },
      { fieldname: "cb2", fieldtype: "Column Break" },
      { label: "Call Notes", fieldname: "call_notes", fieldtype: "Small Text" }
    ];

    await frappe.db.get_value("Selling Step", sell_type, "create_event", function (value) {
      if (value.create_event == 1) {
        fields.push(
          { label: "Events", fieldname: "Sb1", fieldtype: "Section Break" },
          { label: "NEXT STEP", fieldname: "selling_step", fieldtype: "Link", options: "Selling Step", reqd: 1 },
          { label: "Starts On", fieldname: "starts_on", fieldtype: "Datetime", reqd: 1 },
          { label: "Subject", fieldname: "subject", fieldtype: "Data", reqd: 1 },
          { fieldname: "cb3", fieldtype: "Column Break" },
          { label: "Descriptions", fieldname: "descriptions", fieldtype: "Small Text", reqd: 1 }
        );
      }
    });

    var d = new frappe.ui.Dialog({
      static: 1,
      fields: fields,
      primary_action_label: __("Submit"),
      primary_action: function (values) {
        d.hide();
        const sid = con?.parameters?.CallSid;
        if (!sid) return;

        frappe.call({
          method: "twilio_integration.twilio_integration.api.set_call_details",
          args: { call_sid: sid, sell_type: sell_type, values: values }
        });

        frappe.call({
          method: "twilio_integration.twilio_integration.api.create_event",
          args: { call_ref: sid, values: values, sell_type: sell_type }
        });
      }
    });

    d.get_close_btn().hide();
    d.show();
  }

  function get_status_indicator(status) {
    const indicator_map = {
      available: "blue",
      completed: "blue",
      failed: "red",
      busy: "yellow",
      "no-answer": "orange",
      queued: "orange",
      ringing: "green blink",
      "in-progress": "green blink"
    };
    return `indicator ${indicator_map[status] || "blue blink"}`;
  }

  class TwilioCallPopup {
    constructor(twilio_device) {
      this.twilio_device = twilio_device;
      this.dialog = null;
      this.dialpad = null;
    }

    hide_hangup_button() {
      this.dialog.get_secondary_btn().addClass("hide");
    }

    set_header(status) {
      if (!this.dialog) return;
      this.dialog.set_title(frappe.model.unscrub(status));
      const indicator_class = get_status_indicator(status);
      this.dialog.header.find(".indicator").attr("class", `indicator ${indicator_class}`);
    }

    setup_mute_button(twilio_call) {
      let me = this;
      let mute_button = me.dialog.custom_actions.find(".btn-mute");
      mute_button.removeClass("hide");
      mute_button.off("click").on("click", function () {
        const isMute = $(this).text().trim() === "Mute";
        try {
          twilio_call.mute(isMute);
          $(this).html(isMute ? "Unmute" : "Mute");
        } catch (_) { /* ignore */ }
      });
    }

    hide_mute_button() {
      this.dialog.custom_actions.find(".btn-mute").addClass("hide");
    }

    show_close_button() {
      this.dialog.get_close_btn().show();
    }

    close() {
      this.dialog.cancel();
    }

    setup_dialpad(call) {
      con = call;
      let me = this;
      this.dialpad = new DialPad({
        twilio_device: this.twilio_device,
        wrapper: me.dialog.$wrapper.find(".dialpad-section"),
        events: {
          dialpad_event: function ($btn) {
            const button_value = $btn.attr("data-button-value");
            try {
              call.sendDigits(button_value);
              me.update_dialpad_input(button_value);
            } catch (_) { /* ignore */ }
          }
        },
        cols: 5,
        keys: [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
          ["*", 0, "#"]
        ]
      });
    }

    update_dialpad_input(key) {
      let el = this.dialog.$wrapper.find(".dialpad-input")[0];
      if (el) el.value += key;
    }

    setup_dial_icon() {
      let me = this;
      let dialpad_icon = this.dialog.$wrapper.find(".dialpad-icon");
      dialpad_icon.removeClass("hide");
      dialpad_icon.off("click").on("click", function () {
        let dialpad_section = me.dialog.$wrapper.find(".dialpad-section");
        if (dialpad_section.hasClass("hide")) me.show_dialpad();
        else me.hide_dialpad();
      });
    }

    hide_dial_icon() {
      this.dialog.$wrapper.find(".dialpad-icon").addClass("hide");
    }

    show_dialpad() {
      this.dialog.$wrapper.find(".dialpad-section").removeClass("hide");
    }

    hide_dialpad() {
      this.dialog.$wrapper.find(".dialpad-section").addClass("hide");
    }
  }

  class OutgoingCallPopup extends TwilioCallPopup {
    constructor(twilio_device, phone_numbers) {
      super(twilio_device);
      this.phone_numbers = phone_numbers || [];
    }

    async show() {
      if (window.cur_frm && cur_frm.doc && cur_frm.doc.custom_selling_step) {
        await frappe.db.get_value(
          "Selling Step",
          cur_frm.doc.custom_selling_step,
          "call_instructions",
          function (value) {
            def = value.call_instructions;
          }
        );
      }

      this.dialog = new frappe.ui.Dialog({
        static: 1,
        title: __("Make a Call"),
        minimizable: true,
        fields: [
          {
            fieldname: "to_number",
            label: "To Number",
            fieldtype: "Data",
            ignore_validation: true,
            options: this.phone_numbers,
            default: this.phone_numbers[0] || "",
            read_only: 0,
            reqd: 1
          },
          {
            fieldname: "sell_type",
            label: "Sell Type",
            fieldtype: "Link",
            options: "Selling Step",
            default: (cur_frm && cur_frm.doc && cur_frm.doc.custom_selling_step) || "",
            reqd: 1,
            onchange: () => {
              const sell_type = this.dialog.get_value("sell_type");
              const z = this.dialog;
              frappe.db.get_value("Selling Step", sell_type, "call_instructions", function (value) {
                z.set_value("instructions", value.call_instructions);
              });
            }
          },
          {
            fieldname: "instructions",
            label: "Instructions",
            fieldtype: "Text Editor",
            read_only: 1,
            default: def || ""
          }
        ],
        primary_action_label: __("Call"),
        primary_action: () => {
          this.dialog.disable_primary_action();

          const to = this.dialog.get_value("to_number");
          if (!to) {
            this.dialog.enable_primary_action();
            return;
          }

          if (!this.twilio_device) {
            console.error("[Twilio] Device not ready.");
            this.dialog.enable_primary_action();
            return;
          }

          try {
            // v2 connect signature
            const call = this.twilio_device.connect({ params: { To: to } });
            call.__incoming = false;
            linkPopup(call, this);
            wire_call_events(call, this);
          } catch (e) {
            console.error("[Twilio] device.connect failed:", e);
            this.dialog.enable_primary_action();
          }
        },
        secondary_action_label: __("Hang Up"),
        secondary_action: () => {
          try {
            this.twilio_device && this.twilio_device.disconnectAll();
          } catch (_) { /* ignore */ }
        },
        onhide: () => {
          try {
            this.twilio_device && this.twilio_device.disconnectAll();
          } catch (_) { /* ignore */ }
        }
      });

      let to_number = this.dialog.$wrapper
        .find('[data-fieldname="to_number"]')
        .find('[type="text"]');

      $(
        `<span class="dialpad-icon hide">
          <a class="btn-open no-decoration" title="${__("Dialpad")}">
            ${frappe.utils.icon("dialpad")}
          </a>
        </span>`
      ).insertAfter(to_number);

      $(`<div class="dialpad-section hide"></div>`).insertAfter(
        this.dialog.$wrapper.find(".modal-content")
      );

      this.dialog.add_custom_action("Mute", null, "btn-mute mr-2 hide");
      this.dialog.get_secondary_btn().addClass("hide");
      this.dialog.show();
      this.dialog.get_close_btn().show();

      this.dialog.get_close_btn().off("click").on("click", () => {
        if (call_start == 1) {
          change_status_complete(this.dialog.get_value("sell_type"));
        }
      });
    }
  }

  class IncomingCallPopup extends TwilioCallPopup {
    constructor(twilio_device, call) {
      super(twilio_device);
      this.call = call;
      linkPopup(call, this);
    }

    get_title(caller_details) {
      if (caller_details) {
        return __("Incoming Call From {0}", [caller_details.first_name]);
      }
      return __("Incoming Call From {0}", [
        (this.call.parameters && this.call.parameters.From) || "Unknown"
      ]);
    }

    set_dialog_body(caller_details) {
      let caller_details_html = "";
      if (caller_details) {
        for (const [key, value] of Object.entries(caller_details)) {
          caller_details_html += `<div>${frappe.utils.escape_html(key)}: ${frappe.utils.escape_html(
            String(value)
          )}</div>`;
        }
      } else {
        caller_details_html += `<div>Phone Number: ${
          (this.call.parameters && this.call.parameters.From) || ""
        }</div>`;
      }
      $(`<div>${caller_details_html}</div>`).appendTo(this.dialog.modal_body);
    }

    show(caller_details) {
      this.dialog = new frappe.ui.Dialog({
        static: 1,
        title: this.get_title(caller_details),
        minimizable: true,
        primary_action_label: __("Answer"),
        primary_action: () => {
          this.dialog.disable_primary_action();
          try {
            this.call.accept();
          } catch (e) {
            console.error("[Twilio] call.accept failed:", e);
            this.dialog.enable_primary_action();
          }
        },
        secondary_action_label: __("Hang Up"),
        secondary_action: () => {
          try {
            if (this.call.status && this.call.status() === "pending") {
              this.call.reject();
              this.close();
            }
            this.twilio_device.disconnectAll();
          } catch (_) { /* ignore */ }
        },
        onhide: () => {
          try {
            if (this.call.status && this.call.status() === "pending") {
              this.call.reject();
              this.close();
            }
            this.twilio_device.disconnectAll();
          } catch (_) { /* ignore */ }
        }
      });

      this.set_dialog_body(caller_details);
      this.show_close_button();
      this.dialog.add_custom_action("Mute", null, "btn-mute hide");
      this.dialog.show();
    }
  }

  class DialPad extends OutgoingCallPopup {
    constructor({ twilio_device, wrapper, events, cols, keys, css_classes, fieldnames_map }) {
      super(twilio_device);
      this.wrapper = wrapper;
      this.events = events;
      this.cols = cols;
      this.keys = keys;
      this.css_classes = css_classes || [];
      this.fieldnames = fieldnames_map || {};
      this.init_component();
    }

    init_component() {
      this.prepare_dom();
      this.bind_events();
    }

    prepare_dom() {
      const { keys, css_classes, fieldnames } = this;

      function get_keys() {
        return keys.reduce((a, row, i) => {
          return (
            a +
            row.reduce((a2, number, j) => {
              const class_to_append = css_classes && css_classes[i] ? css_classes[i][j] : "";
              const fieldname =
                fieldnames && fieldnames[number]
                  ? fieldnames[number]
                  : typeof number === "string"
                  ? frappe.scrub(number)
                  : number;

              return (
                a2 +
                `<div class="dialpad-btn ${class_to_append}" data-button-value="${fieldname}">${number}</div>`
              );
            }, "")
          );
        }, "");
      }

      this.wrapper.html(
        `<i class="dialpad--pointer"></i>
         <div class="dialpad-container">
           <input class="dialpad-input form-control" readonly="true">
           <div class="dialpad-keys">
             ${get_keys()}
           </div>
         </div>`
      );
    }

    bind_events() {
      const me = this;
      this.wrapper.off("click", ".dialpad-btn").on("click", ".dialpad-btn", function () {
        me.events.dialpad_event($(this));
      });
    }
  }
};
