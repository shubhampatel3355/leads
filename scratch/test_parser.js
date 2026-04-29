const { validateLeadRow } = require('../src/utils/parser');

const mockRow = {
    'Full Name': 'Jane Doe',
    'Email Address': 'jane@example.com',
    'Phone': '+1234567890',
    'Company': 'Jane Inc',
    'LinkedIn URL': 'https://linkedin.com/in/janedoe',
    'LinkedIn Summary': 'Jane is a seasoned product manager.'
};

const validated = validateLeadRow(mockRow);
console.log('Validated Row:', JSON.stringify(validated, null, 2));

if (validated.linkedin_url === 'https://linkedin.com/in/janedoe' && 
    validated.linkedin_data_summary === 'Jane is a seasoned product manager.') {
    console.log('✅ Parser test PASSED');
} else {
    console.log('❌ Parser test FAILED');
}
