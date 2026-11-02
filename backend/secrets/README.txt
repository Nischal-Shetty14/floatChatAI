FloatChat reads secrets from this folder. Paste real values into the two files below.
The server picks them up on the next chat message or the next alert. You do not need to restart.

1. Chatbot (Google Gemini)
   File: gemini-api-key.txt
   Replace PASTE_YOUR_GEMINI_API_KEY_HERE with your key on that same line, or put the key on a new line under the comments.
   Example:
     AIzaSy................................

2. SMS and WhatsApp (Twilio) — required for admin alerts to actually arrive
   File: twilio.json
   Fill every field:
     accountSid          Twilio Account SID, starts with AC
     authToken           Twilio Auth Token
     smsFromNumber       Your Twilio SMS number, like +14155552671
     whatsappFromNumber  Your Twilio WhatsApp sender, like +14155238886

   SMS is delivered by Twilio to the mobile number saved when a person registers.
   Trial Twilio accounts can text only numbers you verified in the Twilio console.

   WhatsApp uses the same Twilio account. On a sandbox, each phone must first
   join by sending the sandbox join code to the sandbox number from WhatsApp.
   After you have an approved WhatsApp sender, that join step is no longer required.

These files are ignored by git so the keys stay on this computer.
session-secret.txt is created automatically. Leave it alone.

Seeded logins (change the password from the sidebar after you sign in):
  Admin               login id: admin        password: FloatChatAdmin@2026
  Warehouse manager   login id: warehouse    password: FloatChatWarehouse@2026

There is only one admin. Public registration creates a citizen account.
The admin adds warehouse managers from the Admin portal.
