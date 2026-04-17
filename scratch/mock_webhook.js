/**
 * Mock OmniDimension Webhook Script (Standard JSON Format)
 * Use this to simulate a successful call transcript being sent to your backend.
 * 
 * Usage:
 * 1. Find the 'external_call_id' from your 'calls' table (it should no longer be NULL after restarting).
 * 2. Run this script: node backend/scratch/mock_webhook.js <YOUR_EXTERNAL_CALL_ID>
 */

const http = require('http');

const callIdInput = process.argv[2];

if (!callIdInput) {
    console.error('Error: Please provide an external_call_id.');
    console.log('Usage: node backend/scratch/mock_webhook.js <external_call_id>');
    process.exit(1);
}

// Convert input to number if it's numeric, to match the JSON example provided
const callId = isNaN(callIdInput) ? callIdInput : parseInt(callIdInput, 10);

const payload = {
    call_id: callId,
    bot_id: 551,
    bot_name: "Mavixy Outbound Sales Agent",
    phone_number: "+919620457017",
    call_date: new Date().toISOString().replace('T', ' ').split('.')[0],
    call_status: "completed",
    call_duration: 65,
    call_direction: "outbound",
    hangup_source: "user",
    user_email: "mavixyteam@gmail.com",
    call_report: {
        summary: "The lead (Shubham) is interested in branding and web development services. He wants a follow-up call next week.",
        sentiment: "Positive",
        extracted_variables: {
            "interest": "High",
            "service_needed": "Web Dev"
        },
        full_conversation: "Assistant: Hi Shubham, this is Mehul from Mavixy. Is this a good time to chat?\nUser: Yes, sure.\nAssistant: Great! We help businesses with branding and web design. How is your current site performing?\nUser: It's okay but we need a refresh.\nAssistant: I understand. Should I send you some info?\nUser: Yes, please do.",
        interactions: [
            { sequence: 1, user_query: false, bot_response: "Hi Shubham, this is Mehul from Mavixy. Is this a good time to chat?", time: "2026-04-17 13:21:00" },
            { sequence: 2, user_query: "Yes, sure.", bot_response: "Great! We help businesses with branding and web design. How is your current site performing?", time: "2026-04-17 13:21:05" }
        ]
    }
};

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/webhook/call-ended',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload))
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${data}`);
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});

req.write(JSON.stringify(payload));
req.end();
console.log(`Sending mock webhook for call ID: ${callId}...`);
