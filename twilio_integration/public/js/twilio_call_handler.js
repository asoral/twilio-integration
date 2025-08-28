var con;
var call_start = 0;
let def = "";

// Load Twilio SDK safely and initialize after it's ready
$(document).ready(() => {
    console.log("[DEBUG] Desk ready. Injecting Twilio SDK...");

    const script = document.createElement("script");
    script.src = "https://sdk.twilio.com/js/voice-sdk/v2.2.0/twilio-voice.min.js";
    script.type = "text/javascript";
    script.async = true;

    script.onload = () => {
        console.log("[DEBUG] Twilio SDK loaded successfully. Initializing...");
        if (typeof Twilio !== "undefined") {
            try {
                onload_script();
                console.log("[DEBUG] onload_script executed successfully");
            } catch (err) {
                console.error("[ERROR] onload_script execution failed:", err);
            }
        } else {
            console.error("[ERROR] Twilio is still undefined after loading SDK");
        }
    };

    script.onerror = () => {
        console.error("[ERROR] Failed to load Twilio SDK from CDN.");
    };

    document.head.appendChild(script);
});




var onload_script = function() {
    console.log("[DEBUG] Entered onload_script() function.");

    frappe.provide('frappe.phone_call');
    frappe.provide('frappe.twilio_conn_dialog_map');

    console.log("[DEBUG] Checking frappe.boot.twilio_enabled:", frappe.boot.twilio_enabled);

    let device;

    if (frappe.boot.twilio_enabled) {
        console.log("[DEBUG] Twilio integration enabled. Starting setup...");
        frappe.run_serially([
            () => {
                console.log("[DEBUG] Running setup_device()");
                return setup_device();
            },
            () => {
                console.log("[DEBUG] Running dialer_screen()");
                return dialer_screen();
            }
        ]);
    } else {
        console.warn("[DEBUG] Twilio integration is NOT enabled in frappe.boot!");
    }

    function setup_device() {
        console.log("[DEBUG] Inside setup_device(), calling backend for Twilio token...");
        frappe.call({
            method: "twilio_integration.twilio_integration.api.generate_access_token",
            callback: (data) => {
                console.log("[DEBUG] Twilio token response:", data);

                if (!data.message || !data.message.token) {
                    console.error("[ERROR] No token received from backend!");
                    return;
                }

                try {
                    console.log("[DEBUG] Initializing Twilio.Device...");
                    device = new Twilio.Device(data.message.token, {});
                    console.log("[DEBUG] Twilio.Device initialized successfully.");
                } catch (err) {
                    console.error("[ERROR] Failed to initialize Twilio.Device:", err);
                    return;
                }

                // Listen for token expiration
                device.on("tokenWillExpire", function() {
                    console.log("[DEBUG] Token will expire soon. Fetching new token...");
                    frappe.call({
                        method: "twilio_integration.twilio_integration.api.generate_access_token",
                        callback: (data) => {
                            console.log("[DEBUG] Token refresh response:", data);
                            if (data.message && data.message.token) {
                                device.updateToken(data.message.token);
                                console.log("[DEBUG] Twilio token updated successfully.");
                            } else {
                                console.error("[ERROR] Failed to refresh Twilio token.");
                            }
                        }
                    });
                });

                device.on("registered", function() {
                    console.log("[DEBUG] Twilio Device registered.");
                    Object.values(frappe.twilio_conn_dialog_map).forEach(function(popup) {
                        popup.set_header('available');
                    });
                });

                device.on("error", function(error) {
                    console.error("[ERROR] Twilio Device Error:", error.message);
                    Object.values(frappe.twilio_conn_dialog_map).forEach(function(popup) {
                        popup.set_header('Failed');
                    });
                    device.disconnectAll();
                });

                device.on("disconnect", function(conn) {
                    console.log("[DEBUG] Call disconnected:", conn);
                    update_call_log(conn);
                    const popup = frappe.twilio_conn_dialog_map[conn];
                    delete frappe.twilio_conn_dialog_map[conn];
                    if (popup) {
                        console.log("[DEBUG] Updating UI after disconnect...");
                        popup.dialog.enable_primary_action();
                        popup.show_close_button();
                        window.onbeforeunload = null;
                        popup.set_header("available");
                        popup.hide_mute_button();
                        popup.hide_hangup_button();
                        popup.hide_dial_icon();
                        popup.hide_dialpad();
                        if (conn.direction === 'INCOMING') {
                            popup.close();
                        }
                    }
                });

                device.on("connect", function(conn) {
                    console.log("[DEBUG] Call connected:", conn);
                    const popup = frappe.twilio_conn_dialog_map[conn];
                    popup.setup_mute_button(conn);
                    popup.dialog.set_secondary_action_label("Hang Up");
                    popup.set_header("in-progress");
                    window.onbeforeunload = function() {
                        return "You cannot refresh the page during a call.";
                    };
                    popup.setup_dial_icon();
                    popup.setup_dialpad(conn);
                });

                device.on("incoming", function(conn) {
                    console.log("[DEBUG] Incoming call from:", conn.parameters.From);
                    call_screen(conn);
                });
            }
        });
    }

    function dialer_screen() {
        console.log("[DEBUG] Setting up dialer screen...");
        frappe.phone_call.handler = (to_number, frm) => {
            console.log("[DEBUG] phone_call.handler triggered. to_number:", to_number);
            let to_numbers = Array.isArray(to_number) ? to_number : to_number.split('\n');
            console.log("[DEBUG] Final number list:", to_numbers);
            let outgoing_call_popup = new OutgoingCallPopup(device, to_numbers);
            outgoing_call_popup.show();
        };
    }

    function update_call_log(conn, status = "Completed") {
        console.log("[DEBUG] Updating call log. SID:", conn.parameters.CallSid, "Status:", status);
        if (!conn.parameters.CallSid) return;
        frappe.call({
            method: "twilio_integration.twilio_integration.api.update_call_log",
            args: {
                call_sid: conn.parameters.CallSid,
                status: status
            }
        });
    }

    function call_screen(conn) {
        console.log("[DEBUG] Preparing incoming call screen for:", conn.parameters.From);
        frappe.call({
            type: "GET",
            method: "twilio_integration.twilio_integration.api.get_contact_details",
            args: {
                phone: conn.parameters.From
            },
            callback: (data) => {
                console.log("[DEBUG] Contact details response:", data);
                let incoming_call_popup = new IncomingCallPopup(device, conn);
                incoming_call_popup.show(data.message);
            }
        });
    }
};



async function change_status_complete(sell_type)
 {

    let fields= [
        {
            "label": 'Call Rating',
            "fieldname": "call_rating",
            "fieldtype": "Rating",
        },
        {
            "label": 'Request Call Review',
            "fieldname": "request_call_review",
            "fieldtype": "Check",
        },
        {
            "fieldname": "cb1",
            "fieldtype": "Column Break",
        },
        {
            "label": 'Reviewer',
            "fieldname": "reviewer",
            "fieldtype": "Link",
            "options":"User"
        },
        {
            "fieldname": "cb2",
            "fieldtype": "Column Break",
        },
        {
            "label": 'Call Notes',
            "fieldname": "call_notes",
            "fieldtype": "Small Text",
        }
    ]
    await frappe.db.get_value("Selling Step",sell_type, "create_event", function(value) {
        console.log("$$$$$$$$$$$$$$$",value.create_event)
        if (value.create_event==1){
            
            fields.push({
                "label": 'Events',
                "fieldname": "Sb1",
                "fieldtype": "Section Break",
            },{
                "label": 'NEXT STEP',
                "fieldname": "selling_step",
                "fieldtype": "Link",
                "options":"Selling Step",
                "reqd":1
            },
            {
                "label": 'Starts On',
                "fieldname": "starts_on",
                "fieldtype": "Datetime",
                "reqd":1
                },
                {
                    "label": 'Subject',
                    "fieldname": "subject",
                    "fieldtype": "Data",
                    "reqd":1
                },
                {
                    "fieldname": "cb3",
                    "fieldtype": "Column Break",
                },
                {
                    "label": 'Descriptions',
                    "fieldname": "descriptions",
                    "fieldtype": "Small Text",
                    "reqd":1
                })
        }
        console.log("$$$$$$$$$$$$$$$444555dhjdghjdfhjdfhjfdhyyyyyyyyyyy",fields)
        console.log("trigger cdhdhhdjhfdhjdf")
        console.log("uuuuuuuuuuuuuuuuuuuuuuuuuuuu",con.parameters.CallSid)
    
   })
   
   console.log("outside before dialg",fields)
    var d = new frappe.ui.Dialog({
            static: 1,
            fields: fields,
            primary_action: function(values) {

                d.hide();
                if (!con.parameters.CallSid) return
                frappe.call({
                    "method": "twilio_integration.twilio_integration.api.set_call_details",
                    "args": {
                        "call_sid": con.parameters.CallSid,
                        "sell_type":sell_type,
                        "values": values
                    }
                })
                frappe.call({
                    "method": "twilio_integration.twilio_integration.api.create_event",
                    "args": {
                        "call_ref": con.parameters.CallSid,
                        "values": values,
                        "sell_type":sell_type
                    }
                })
            
                


            },
            primary_action_label: __('Submit')
        });
        d.get_close_btn().hide();
        d.show();
        
     

 };
 
function get_status_indicator(status) {
    const indicator_map = {
        'available': 'blue',
        'completed': 'blue',
        'failed': 'red',
        'busy': 'yellow',
        'no-answer': 'orange',
        'queued': 'orange',
        'ringing': 'green blink',
        'in-progress': 'green blink'
    };
    const indicator_class = `indicator ${indicator_map[status] || 'blue blink'}`;
    return indicator_class;
}

class TwilioCallPopup {
    constructor(twilio_device) {
        this.twilio_device = twilio_device;
    }

    hide_hangup_button() {
        this.dialog.get_secondary_btn().addClass('hide');
    }

    set_header(status) {
        if (!this.dialog){
            return;
        }
        this.dialog.set_title(frappe.model.unscrub(status));
        const indicator_class = get_status_indicator(status);
        this.dialog.header.find('.indicator').attr('class', `indicator ${indicator_class}`);
    }

    setup_mute_button(twilio_conn) {
        let me = this;
        let mute_button = me.dialog.custom_actions.find('.btn-mute');
        mute_button.removeClass('hide');
        mute_button.on('click', function (event) {
            if ($(this).text().trim() == 'Mute') {
                twilio_conn.mute(true);
                $(this).html('Unmute');
            }
            else {
                twilio_conn.mute(false);
                $(this).html('Mute');
            }
        });
    }

    hide_mute_button() {
        let mute_button = this.dialog.custom_actions.find('.btn-mute');
        mute_button.addClass('hide');
    }

    show_close_button() {
        this.dialog.get_close_btn().show();
    }

    close() {
        this.dialog.cancel();
    }

    setup_dialpad(conn) {
        con=conn
        let me = this;
        this.dialpad = new DialPad({
            twilio_device: this.twilio_device,
            wrapper: me.dialog.$wrapper.find('.dialpad-section'),
            events: {
                dialpad_event: function($btn) {
                    const button_value = $btn.attr('data-button-value');
                    conn.sendDigits(button_value);
                    me.update_dialpad_input(button_value);
                }
            },
            cols: 5,
            keys: [
                [ 1, 2, 3 ],
                [ 4, 5, 6 ],
                [ 7, 8, 9 ],
                [ '*', 0, '#' ]
            ]
        })
    }

    update_dialpad_input(key) {
        let dialpad_input = this.dialog.$wrapper.find('.dialpad-input')[0];
        dialpad_input.value += key;
    }

    setup_dial_icon() {
        let me = this;
        let dialpad_icon = this.dialog.$wrapper.find('.dialpad-icon');
        dialpad_icon.removeClass('hide');
        dialpad_icon.on('click', function (event) {
            let dialpad_section = me.dialog.$wrapper.find('.dialpad-section');
            if(dialpad_section.hasClass('hide')) {
                me.show_dialpad();
            }
            else {
                me.hide_dialpad();
            }
        });
    }

    hide_dial_icon() {
        let dial_icon = this.dialog.$wrapper.find('.dialpad-icon');
        dial_icon.addClass('hide');
    }

    show_dialpad() {
        let dialpad_section = this.dialog.$wrapper.find('.dialpad-section');
        dialpad_section.removeClass('hide');
    }

    hide_dialpad() {
        let dialpad_section = this.dialog.$wrapper.find('.dialpad-section');
        dialpad_section.addClass('hide');
    }
}

class OutgoingCallPopup extends TwilioCallPopup {
    
    constructor(twilio_device, phone_numbers) {
        super(twilio_device);
        this.phone_numbers = phone_numbers;
    }

    async show() {
        if(cur_frm.doc.custom_selling_step){
            await frappe.db.get_value("Selling Step", cur_frm.doc.custom_selling_step, "call_instructions", function(value) {
            console.log(value)
            def = value.call_instructions
            })
        }
        
        this.dialog = new frappe.ui.Dialog({
            'static': 1,
            'title': __('Make a Call'),
            'minimizable': true,
            'fields': [
                {
                    'fieldname': 'to_number',
                    'label': 'To Number',
                    'fieldtype': 'Data',
                    'ignore_validation': true,
                    'options': this.phone_numbers,
                    'default': this.phone_numbers[0],
                    'read_only': 0,
                    'reqd': 1
                },
                {
                    'fieldname': 'sell_type',
                    'label': 'Sell Type',
                    'fieldtype': 'Link',
                    'options': "Selling Step",
                    "default":cur_frm.doc.custom_selling_step,
                    "reqd":1,
                    onchange: () => {
                        let z=this.dialog
                        const sell_type = this.dialog.get_value('sell_type');

                        frappe.db.get_value("Selling Step", sell_type, "call_instructions", function(value) {
                            console.log(value)
                            z.set_value('instructions',value.call_instructions);
                            })

                    }
                },
                {
                    'fieldname': 'instructions',
                    'label': 'Instructions',
                    'fieldtype': 'Text Editor',
                    "read_only": 1,
                    "default":def
                }
            ],
            primary_action: () => {
                this.dialog.disable_primary_action();

                var params = {
                    To: this.dialog.get_value('to_number')
                };

                if (this.twilio_device) {
                    let me = this;
                    let outgoingConnection = this.twilio_device.connect(params);
                    frappe.twilio_conn_dialog_map[outgoingConnection] = this;
                    outgoingConnection.on("ringing", function () {
                        me.set_header('ringing');
                        call_start=1
                    });
                } else {
                    this.dialog.enable_primary_action();
                }
            },
            primary_action_label: __('Call'),
            
            secondary_action: () => {
                if (this.twilio_device) {
                    this.twilio_device.disconnectAll();
                }
            },
            onhide: () => {
                if (this.twilio_device) {
                    this.twilio_device.disconnectAll();
                }
            }
        });
        let to_number = this.dialog.$wrapper.find('[data-fieldname="to_number"]').find('[type="text"]');

        $(`<span class="dialpad-icon hide">
            <a class="btn-open no-decoration" title="${__('Dialpad')}">
                ${frappe.utils.icon('dialpad')}
        </span>`).insertAfter(to_number);

        $(`<div class="dialpad-section hide"></div>`)
        .insertAfter(this.dialog.$wrapper.find('.modal-content'));

        this.dialog.add_custom_action('Mute', null, 'btn-mute mr-2 hide');
        this.dialog.get_secondary_btn().addClass('hide');
        this.dialog.show();
        this.dialog.get_close_btn().show();
        this.dialog.get_close_btn().on('click', () => {
            if (call_start== 1){
                console.log("$$$$$$$$$$$$$Calling")
                change_status_complete(this.dialog.get_value('sell_type'))
            }
        });
    }
}

class IncomingCallPopup extends TwilioCallPopup {
    constructor(twilio_device, conn) {
        super(twilio_device);
        this.conn = conn;
        frappe.twilio_conn_dialog_map[conn] = this; // CHECK: Is this the place?
    }

    get_title(caller_details) {
        let title;
        if (caller_details){
            title = __('Incoming Call From {0}', [caller_details.first_name]);
        } else {
            title = __('Incoming Call From {0}', [this.conn.parameters.From]);
        }
        return title;
    }

    set_dialog_body(caller_details) {
        var caller_info = $(`<div></div>`);
        let caller_details_html = '';
        if (caller_details) {
            for (const [key, value] of Object.entries(caller_details)) {
                caller_details_html += `<div>${key}: ${value}</div>`;
            }
        } else {
            caller_details_html += `<div>Phone Number: ${this.conn.parameters.From}</div>`;
        }
        $(`<div>${caller_details_html}</div>`).appendTo(this.dialog.modal_body);
    }

    show(caller_details) {
        this.dialog = new frappe.ui.Dialog({
            'static': 1,
            'title': this.get_title(caller_details),
            'minimizable': true,
            primary_action: () => {
                this.dialog.disable_primary_action();
                this.conn.accept();
            },
            primary_action_label: __('Answer'),
            secondary_action: () => {
                if (this.twilio_device) {
                    if (this.conn.status() == 'pending') {
                        this.conn.reject();
                        this.close();
                    }
                    this.twilio_device.disconnectAll();
                }
            },
            secondary_action_label: __('Hang Up'),
            onhide: () => {
                if (this.twilio_device) {
                    if (this.conn.status() == 'pending') {
                        this.conn.reject();
                        this.close();
                    }
                    this.twilio_device.disconnectAll();
                }
            }
        });
        this.set_dialog_body(caller_details);
        this.show_close_button();
        this.dialog.add_custom_action('Mute', null, 'btn-mute hide');
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
        const { cols, keys, css_classes, fieldnames } = this;

        function get_keys() {
            return keys.reduce((a, row, i) => {
                return a + row.reduce((a2, number, j) => {
                    const class_to_append = css_classes && css_classes[i] ? css_classes[i][j] : '';
                    const fieldname = fieldnames && fieldnames[number] ?
                        fieldnames[number] : typeof number === 'string' ? frappe.scrub(number) : number;

                    return a2 + `<div class="dialpad-btn ${class_to_append}" data-button-value="${fieldname}">${number}</div>`;
                }, '');
            }, '');
        }

        this.wrapper.html(
            `<i class="dialpad--pointer"></i>
            <div class="dialpad-container">
                <input class="dialpad-input form-control" readonly="true">
                <div class="dialpad-keys">
                    ${get_keys()}
                </div>
            </div>`
        )
    }

    bind_events() {
        const me = this;
        this.wrapper.on('click', '.dialpad-btn', function() {
            const $btn = $(this);
            me.events.dialpad_event($btn);
        });
    }
}

// var script = document.createElement('script');
// document.head.appendChild(script);
// script.onload = onload_script;
// // Change 2: Updated the SDK URL
// script.src = "https://sdk.twilio.com/js/voice-sdk/v2.15.0/twilio-voice.min.js"
