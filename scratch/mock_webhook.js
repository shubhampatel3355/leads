/**
 * Mock OmniDimension Webhook Script
 * Use this to simulate a successful call transcript being sent to your backend.
 * 
 * Usage:
 * 1. Find the 'external_call_id' from your 'calls' table in the database.
 * 2. Run this script: node mock_webhook.js <YOUR_EXTERNAL_CALL_ID>
 */

const http = require('http');

const callId = process.argv[2];

if (!callId) {
    console.error('Error: Please provide an external_call_id.');
    console.log('Usage: node mock_webhook.js <external_call_id>');
    process.exit(1);
}

const payload = {
    call_id: callId,
    status: 'completed',
    transcript: [
        { role: 'agent', content: 'Hi, this is Mavixy. How are you today?' },
        { role: 'user', content: 'I am doing well, thank you. What do you do?' },
        { role: 'agent', content: 'We help businesses with branding and web development. Are you interested in improving your digital presence?' },
        { role: 'user', content: 'Yes, our current website is quite old. Could you send me more info?' }
    ],
    recording_url: 'https://example.com/recording.mp3',
    duration: 45,
    summary: 'The lead is interested in web development services and asked for more information.'
};

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/webhook/call-ended',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': JSON.stringify(payload).length
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
