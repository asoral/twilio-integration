import json
from werkzeug.wrappers import Response

import frappe
from frappe import _
from frappe.contacts.doctype.contact.contact import get_contact_with_phone_number
from .twilio_handler import Twilio, IncomingCall, TwilioCallDetails
from twilio_integration.twilio_integration.doctype.whatsapp_message.whatsapp_message import incoming_message_callback
from twilio.twiml.messaging_response import MessagingResponse

@frappe.whitelist()
def get_twilio_phone_numbers():
	twilio = Twilio.connect()
	return (twilio and twilio.get_phone_numbers()) or []

@frappe.whitelist()
def generate_access_token():
	"""Returns access token that is required to authenticate Twilio Client SDK.
	"""
	twilio = Twilio.connect()
	if not twilio:
		return {}

	from_number = frappe.db.get_value('Voice Call Settings', frappe.session.user, 'twilio_number')
	if not from_number:
		return {
			"ok": False,
			"error": "caller_phone_identity_missing",
			"detail": "Phone number is not mapped to the caller"
		}

	token=twilio.generate_voice_access_token(from_number=from_number, identity=frappe.session.user)
	return {
		'token': frappe.safe_decode(token)
	}

@frappe.whitelist(allow_guest=True)
def voice(**kwargs):
	"""This is a webhook called by twilio to get instructions when the voice call request comes to twilio server.
	"""
	def _get_caller_number(caller):
		identity = caller.replace('client:', '').strip()
		user = Twilio.emailid_from_identity(identity)
		return frappe.db.get_value('Voice Call Settings', user, 'twilio_number'),user

	args = frappe._dict(kwargs)
	twilio = Twilio.connect()
	if not twilio:
		return

	assert args.AccountSid == twilio.account_sid
	assert args.ApplicationSid == twilio.application_sid

	# Generate TwiML instructions to make a call
	from_number = _get_caller_number(args.Caller)
	resp = twilio.generate_twilio_dial_response(from_number[0], args.To)

	call_details = TwilioCallDetails(args, call_from=from_number[0])
	abc=create_call_log(call_details)
	if abc:
		doc=frappe.get_doc("Call Log",abc)
		doc.custom_voip_user=from_number[1]
		doc.save(ignore_permissions=True)
	return Response(resp.to_xml(), mimetype='text/xml')

@frappe.whitelist(allow_guest=True)
def twilio_incoming_call_handler(**kwargs):
	args = frappe._dict(kwargs)
	call_details = TwilioCallDetails(args)
	abc=create_call_log(call_details)
	resp = IncomingCall(args.From, args.To).process(abc)
	
	return Response(resp.to_xml(), mimetype='text/xml')

@frappe.whitelist()
def create_call_log(call_details: TwilioCallDetails):
	call_log = frappe.get_doc({**call_details.to_dict(),
		'doctype': 'Call Log',
		'medium': 'Twilio'
	})

	call_log.flags.ignore_permissions = True
	call_log.save()
	frappe.db.commit()
	return call_log.name

@frappe.whitelist()
def update_call_log(call_sid, status=None):
	"""Update call log status.
	"""
	twilio = Twilio.connect()
	if not (twilio and frappe.db.exists("Call Log", call_sid)): return

	call_details = twilio.get_call_info(call_sid)
	call_log = frappe.get_doc("Call Log", call_sid)
	call_log.status = status or TwilioCallDetails.get_call_status(call_details.status)
	call_log.duration = call_details.duration
	call_log.custom_call_info=str(call_details.__dict__)
	call_log.flags.ignore_permissions = True
	call_log.save()
	frappe.db.commit()

@frappe.whitelist(allow_guest=True)
def update_recording_info(**kwargs):
	try:
		args = frappe._dict(kwargs)
		recording_url = args.RecordingUrl
		call_sid = args.CallSid
		update_call_log(call_sid)
		frappe.db.set_value("Call Log", call_sid, "recording_url", recording_url)
	except:
		frappe.log_error(title=_("Failed to capture Twilio recording"))

@frappe.whitelist()
def get_contact_details(phone):
	"""Get information about existing contact in the system.
	"""
	contact = get_contact_with_phone_number(phone.strip())
	if not contact: return
	contact_doc = frappe.get_doc('Contact', contact)
	return contact_doc and {
		'first_name': contact_doc.first_name.title(),
		'email_id': contact_doc.email_id,
		'phone_number': contact_doc.phone
	}

@frappe.whitelist(allow_guest=True)
def incoming_whatsapp_message_handler(**kwargs):
	"""This is a webhook called by Twilio when a WhatsApp message is received.
	"""
	args = frappe._dict(kwargs)
	incoming_message_callback(args)
	resp = MessagingResponse()

	# Add a message
	resp.message(frappe.db.get_single_value('Twilio Settings', 'reply_message'))
	return Response(resp.to_xml(), mimetype='text/xml')

@frappe.whitelist(allow_guest=True)
def whatsapp_message_status_callback(**kwargs):
	"""This is a webhook called by Twilio whenever sent WhatsApp message status is changed.
	"""
	args = frappe._dict(kwargs)
	if frappe.db.exists({'doctype': 'WhatsApp Message', 'id': args.MessageSid, 'from_': args.From, 'to': args.To}):
		message = frappe.get_doc('WhatsApp Message', {'id': args.MessageSid, 'from_': args.From, 'to': args.To})
		message.db_set('status', args.MessageStatus.title())
@frappe.whitelist()
def set_call_details(call_sid,sell_type,values):
	"""Update call log status.
	"""
	twilio = Twilio.connect()
	if not (twilio and frappe.db.exists("Call Log", call_sid)): return
	a=json.loads(values)
	call_log = frappe.get_doc("Call Log", call_sid)
	call_log.custom_ratings=a.get("call_ratings")
	call_log.custom_request_call_review=a.get("request_call_review")
	call_log.custom_reviewer=a.get("reviewer")
	call_log.custom_sell_type=sell_type
	call_log.custom_call_notes=a.get("call_notes")
	call_log.flags.ignore_permissions = True
	call_log.save()
	frappe.db.commit()


@frappe.whitelist()
def create_event(call_ref,values,sell_type):
	values=json.loads(values)
	if values.get("selling_step"):
		doc=frappe.get_doc("Selling Step",sell_type)
		if doc.create_event==1:
			call_log = frappe.get_doc("Call Log", call_ref)
			event=frappe.new_doc("Event")
			event.starts_on=values.get("starts_on")
			event.subject=values.get("subject")
			event.event_category="Call"
			event.event_type="Private"
			event.description=values.get("descriptions")
			event.custom_call_log=call_ref
			if call_log.links:
				for link in call_log.links:
					event.append("event_participants", {
						"reference_doctype": link.link_doctype,
						"reference_docname": link.link_name
					})
			event.flags.ignore_permissions = True
			event.save()
			frappe.db.commit()
# @frappe.whitelist()
# def fetch_contact(doc,method):
# 	if doc.type=="Incoming":
# 		doc=frappe.get_doc("Contact Phone",{"phone":doc.})
	
