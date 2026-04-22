/**
 * Verification Script: OmniDimension Webhook ID Matching
 */
const mockPayloads = [
    { name: 'Standard call_id', body: { call_id: 'C123', status: 'completed' }, expected: 'C123' },
    { name: 'Dispatch ID', body: { dispatch_id: 'D456', status: 'completed' }, expected: 'D456' },
    { name: 'Request ID', body: { request_id: 'R789', status: 'completed' }, expected: 'R789' },
    { name: 'SID', body: { sid: 'S000', status: 'completed' }, expected: 'S000' },
    { name: 'Nested ID', body: { id: 'I111', status: 'completed' }, expected: 'I111' },
];

function extractId(body) {
    return body.call_id || body.id || body.dispatch_id || body.callLogId || body.request_id || body.sid;
}

console.log('--- Testing Webhook ID Extraction ---');
mockPayloads.forEach(p => {
    const extracted = extractId(p.body);
    const success = extracted === p.expected;
    console.log(`[${success ? 'PASS' : 'FAIL'}] ${p.name}: Got "${extracted}", Expected "${p.expected}"`);
});

console.log('\n--- Testing Transcript Sanitization ---');
const transcriptText = "['Hello world']";
let cleanTranscript = Array.isArray(transcriptText) ? transcriptText.join('\n') : String(transcriptText);
cleanTranscript = cleanTranscript.trim()
    .replace(/^\[['"]?/, '')
    .replace(/['"]?\]$/, '')
    .replace(/\\n/g, '\n');

const transcriptOk = cleanTranscript === 'Hello world';
console.log(`[${transcriptOk ? 'PASS' : 'FAIL'}] Sanitization: Got "${cleanTranscript}", Expected "Hello world"`);
