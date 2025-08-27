var con;
var call_start = 0;
let def = "";
var device;

var onload_script = function() {
    frappe.provide('frappe.phone_call');
    frappe.provide('frappe.twilio_conn_dialog_map');

    if (frappe.boot.twilio_enabled) {
        frappe.run_serially([
            () => setup_device(),
            () => dialer_screen()
        ]);
    }

    function setup_device() {
        return new Promise((resolve) => {
            frappe.call({
                method: "twilio_integration.twilio_integration.api.generate_access_token",
                callback: (data) => {
                    if (!data.message || !data.message.token) {
                        frappe.msgprint(__('Failed to get Twilio access token'));
                        resolve();
                        return;
                    }

                    device = new Twilio.Device(data.message.token, {
                        codecPreferences: ["opus", "pcmu"],
                        fakeLocalDTMF: true,
                        enableRingingState: true
                    });

                    device.on("ready", function(device) {
                        Object.values(frappe.twilio_conn_dialog_map).forEach(function(popup) {
                            popup.set_header('available');
                        });
                        resolve();
                    });

                    device.on("error", function(error) {
                        Object.values(frappe.twilio_conn_dialog_map).forEach(function(popup) {
                            popup.set_header('Failed');
                        });
                        if(device) device.disconnectAll();
                        console.error("Twilio Device Error: " + error.message);
                        resolve();
                    });

                    device.on("disconnect", function(conn) {
                        update_call_log(conn);
                        const popup = frappe.twilio_conn_dialog_map[conn.parameters.CallSid];
                        if (popup) {
                            // Remove the connection from map object
                            delete frappe.twilio_conn_dialog_map[conn.parameters.CallSid];
                            popup.dialog.enable_primary_action();
                            popup.show_close_button();
                            window.onbeforeunload = null;
                            popup.set_header("available");
                            popup.hide_mute_button();
                            popup.hide_hangup_button();
                            popup.hide_dial_icon();
                            popup.hide_dialpad();
                            // Close dialog if incoming call ends
                            if (conn.direction === 'INCOMING') {
                                popup.close();
                            }
                        }
                    });

                    device.on("cancel", function() {
                        Object.values(frappe.twilio_conn_dialog_map).forEach(function(popup){
                            popup.close();
                        });
                    });

                    device.on("connect", function(conn) {
                        const popup = frappe.twilio_conn_dialog_map[conn.parameters.CallSid];
                        if (!popup) return;

                        popup.setup_mute_button(conn);
                        popup.dialog.set_secondary_action_label("Hang Up");
                        popup.set_header("in-progress");
                        window.onbeforeunload = function() {
                            return "You cannot refresh the page during a call";
                        };

                        popup.setup_dial_icon();
                        popup.setup_dialpad(conn);

                        document.onkeydown = (e) => {
                            if (popup.dialog.$wrapper.find('.dialpad-section').is(":hidden")) return;
                            let key = e.key;
                            if (conn.status() === 'open' && ["0","1","2","3","4","5","6","7","8","9","*","#","w"].includes(key)) {
                                conn.sendDigits(key);
                                popup.update_dialpad_input(key);
                            }
                        };
                    });

                    device.on("incoming", function(conn) {
                        console.log("Incoming connection from " + conn.parameters.From);
                        con = conn;
                        call_screen(conn);
                    });

                    device.on("tokenWillExpire", function() {
                        console.log("Twilio token is about to expire, getting a new one...");
                        frappe.call({
                            method: "twilio_integration.twilio_integration.api.generate_access_token",
                            callback: (data) => {
                                if (data.message && data.message.token) {
                                    device.updateToken(data.message.token);
                                    console.log("Twilio token updated successfully.");
                                } else {
                                    console.error("Failed to retrieve a new token.");
                                }
                            }
                        });
                    });
                }
            });
        });
    }

    function dialer_screen() {
        frappe.phone_call.handler = (to_number, frm) => {
            let to_numbers;
            if (Array.isArray(to_number)) {
                to_numbers = to_number;
            } else {
                to_numbers = to_number.split('\n');
            }
            let outgoing_call_popup = new OutgoingCallPopup(device, to_numbers);
            outgoing_call_popup.show();
        };
    }

    function update_call_log(conn, status = "Completed") {
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
        frappe.call({
            type: "GET",
            method: "twilio_integration.twilio_integration.api.get_contact_details",
            args: { 'phone': conn.parameters.From },
            callback: (data) => {
                let incoming_call_popup = new IncomingCallPopup(device, conn);
                incoming_call_popup.show(data.message);
            }
        });
    }
};

class TwilioCallPopup {
    constructor(twilio_device) {
        this.twilio_device = twilio_device;
    }

    hide_hangup_button() {
        this.dialog.get_secondary_btn().addClass('hide');
    }

    set_header(status) {
        if (!this.dialog) return;
        this.dialog.set_title(frappe.model.unscrub(status));
        const indicator_class = get_status_indicator(status);
        this.dialog.header.find('.indicator').attr('class', `indicator ${indicator_class}`);
    }

    setup_mute_button(twilio_conn) {
        let me = this;
        let mute_button = me.dialog.custom_actions.find('.btn-mute');
        mute_button.removeClass('hide');
        mute_button.off('click').on('click', function() {
            if ($(this).text().trim() == 'Mute') {
                twilio_conn.mute(true);
                $(this).html('Unmute');
            } else {
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
                [1, 2, 3],
                [4, 5, 6],
                [7, 8, 9],
                ['*', 0, '#']
            ]
        });
    }

    update_dialpad_input(key) {
        let dialpad_input = this.dialog.$wrapper.find('.dialpad-input')[0];
        dialpad_input.value += key;
    }

    setup_dial_icon() {
        let me = this;
        let dialpad_icon = this.dialog.$wrapper.find('.dialpad-icon');
        dialpad_icon.removeClass('hide');
        dialpad_icon.off('click').on('click', function() {
            let dialpad_section = me.dialog.$wrapper.find('.dialpad-section');
            if (dialpad_section.hasClass('hide')) {
                me.show_dialpad();
            } else {
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
        if (cur_frm.doc.custom_selling_step) {
            await frappe.db.get_value("Selling Step", cur_frm.doc.custom_selling_step, "call_instructions", function(value) {
                def = value.call_instructions;
            });
        }

        this.dialog = new frappe.ui.Dialog({
            static: 1,
            title: __('Make a Call'),
            minimizable: true,
            fields: [
                {
                    fieldname: 'to_number',
                    label: 'To Number',
                    fieldtype: 'Data',
                    ignore_validation: true,
                    options: this.phone_numbers,
                    default: this.phone_numbers[0],
                    read_only: 0,
                    reqd: 1
                },
                {
                    fieldname: 'sell_type',
                    label: 'Sell Type',
                    fieldtype: 'Link',
                    options: "Selling Step",
                    default: cur_frm.doc.custom_selling_step,
                    reqd: 1,
                    onchange: () => {
                        const sell_type = this.dialog.get_value('sell_type');
                        frappe.db.get_value("Selling Step", sell_type, "call_instructions", (value) => {
                            this.dialog.set_value('instructions', value.call_instructions);
                        });
                    }
                },
                {
                    fieldname: 'instructions',
                    label: 'Instructions',
                    fieldtype: 'Text Editor',
                    read_only: 1,
                    default: def
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
                    frappe.twilio_conn_dialog_map[outgoingConnection.parameters.CallSid] = this;

                    outgoingConnection.on("ringing", function () {
                        me.set_header('ringing');
                        call_start = 1;
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
            </a>
        </span>`).insertAfter(to_number);

        $(`<div class="dialpad-section hide"></div>`)
            .insertAfter(this.dialog.$wrapper.find('.modal-content'));

        this.dialog.add_custom_action('Mute', null, 'btn-mute mr-2 hide');
        this.dialog.get_secondary_btn().addClass('hide');
        this.dialog.show();
        this.dialog.get_close_btn().show();
        this.dialog.get_close_btn().on('click', () => {
            if (call_start == 1) {
                change_status_complete(this.dialog.get_value('sell_type'));
            }
        });
    }
}

class IncomingCallPopup extends TwilioCallPopup {
    constructor(twilio_device, conn) {
        super(twilio_device);
        this.conn = conn;
        frappe.twilio_conn_dialog_map[conn.parameters.CallSid] = this;
    }

    get_title(caller_details) {
        if (caller_details) {
            return __('Incoming Call From {0}', [caller_details.first_name]);
        } else {
            return __('Incoming Call From {0}', [this.conn.parameters.From]);
        }
    }

    set_dialog_body(caller_details) {
        var caller_details_html = '';
        if (caller_details) {
            for (const [key, value] of Object.entries(caller_details)) {
                caller_details_html += `<div>${key}: ${value}</div>`;
            }
        } else {
            caller_details_html += `<div>Phone Number: ${this.conn.parameters.From}</div>`;
        }
        this.dialog.modal_body.html(caller_details_html);
    }

    show(caller_details) {
        this.dialog = new frappe.ui.Dialog({
            static: 1,
            title: this.get_title(caller_details),
            minimizable: true,
            primary_action: () => {
                this.dialog.disable_primary_action();
                this.conn.accept();
            },
            primary_action_label: __('Answer'),
            secondary_action: () => {
                if (this.twilio_device) {
                    if (this.conn.status() === 'pending') {
                        this.conn.reject();
                        this.close();
                    }
                    this.twilio_device.disconnectAll();
                }
            },
            secondary_action_label: __('Hang Up'),
            onhide: () => {
                if (this.twilio_device) {
                    if (this.conn.status() === 'pending') {
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
    constructor({twilio_device, wrapper, events, cols, keys, css_classes, fieldnames_map}) {
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
        const {cols, keys, css_classes, fieldnames} = this;

        function get_keys() {
            return keys.reduce((acc, row, i) => {
                return acc + row.reduce((acc2, number, j) => {
                    const class_to_append = css_classes && css_classes[i] ? css_classes[i][j] : '';
                    const fieldname = fieldnames && fieldnames[number] ? fieldnames[number] : (typeof number === 'string' ? frappe.scrub(number) : number);

                    return acc2 + `<div class="dialpad-btn ${class_to_append}" data-button-value="${fieldname}">${number}</div>`;
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
        );
    }

    bind_events() {
        const me = this;
        this.wrapper.off('click', '.dialpad-btn').on('click', '.dialpad-btn', function() {
            const $btn = $(this);
            me.events.dialpad_event($btn);
        });
    }
}

var script = document.createElement('script');
script.src = "https://sdk.twilio.com/js/voice-sdk/v2.0/twilio-voice.min.js";
document.head.appendChild(script);
script.onload = onload_script;
