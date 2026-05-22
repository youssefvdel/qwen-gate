import { robustParseJSON } from '../utils/json.ts';

const problematicString = '{"name": "suggest", "arguments": {"suggest": "Landing page para escritório de advocacia criada em src/pages/Index.tsx", "actions": [{"label": "Revisar alterações", "description": "Executar review local das mudanças não commitadas", "prompt": "/local-review-uncommitted"}]})';

console.log('Testing problematic string...');
try {
    const result = robustParseJSON(problematicString);
    console.log('Successfully parsed:', JSON.stringify(result, null, 2));
    if (result.name === 'suggest' && result.arguments.actions.length === 1) {
        console.log('✅ Problematic string test passed!');
    } else {
        console.error('❌ Result structure is incorrect');
    }
} catch (e) {
    console.error('❌ Failed to parse problematic string:', e);
}

const missingBraces = '{"name": "test", "arguments": {"foo": "bar"';
console.log('\nTesting missing braces...');
try {
    const result = robustParseJSON(missingBraces);
    console.log('Successfully parsed:', JSON.stringify(result, null, 2));
    if (result.arguments.foo === 'bar') {
        console.log('✅ Missing braces test passed!');
    } else {
        console.error('❌ Result structure is incorrect');
    }
} catch (e) {
    console.error('❌ Failed to parse missing braces:', e);
}

const controlChars = '{"name": "control", "msg": "line 1\\nline 2"}';
console.log('\nTesting control characters in string...');
try {
    // Note: in a real string from the model, it would be a literal newline
    const literalNewline = '{"name": "control", "msg": "line 1\\nline 2"}'.replace('\\n', '\n');
    const result = robustParseJSON(literalNewline);
    console.log('Successfully parsed:', JSON.stringify(result, null, 2));
    if (result.msg.includes('line 1') && result.msg.includes('line 2')) {
        console.log('✅ Control characters test passed!');
    } else {
        console.error('❌ Result content is incorrect');
    }
} catch (e) {
    console.error('❌ Failed to parse control characters:', e);
}

const crazyCase = `{"name": "suggest", "arguments": {"suggest": "Landing page criada para escritório de advocacia com design corporativo", "actions": [{"label": "Revisar código local", "description": "Exec<tool_call>\n{"name": "bashutar revisão local das", "arguments": alterações {"command": não commitadas", "npm run lint "prompt", "description":": "/local-review "Run lint-uncommitted"}] to verify code quality})"}}`;
console.log('\nTesting crazy nested hallucination case...');
try {
    const result = robustParseJSON(crazyCase);
    console.log('Successfully parsed (at least some of it):', JSON.stringify(result, null, 2));
    console.log('✅ Crazy case handled without crashing!');
} catch (e: any) {
    console.log('⚠️ Crazy case failed (too malformed), but error was:', e.message);
}

const invalidEscapes = '{"path": "C:\\\\Users\\\\name\\\\Documents"}';
console.log('\nTesting invalid backslash escapes in string...');
try {
    const result = robustParseJSON(invalidEscapes);
    console.log('Successfully parsed:', JSON.stringify(result, null, 2));
    if (result.path === 'C:\\\\Users\\\\name\\\\Documents' || result.path === 'C:\\Users\\name\\Documents') {
        console.log('✅ Invalid backslash escapes test passed!');
    } else {
        console.error('❌ Result path is incorrect:', result.path);
    }
} catch (e) {
    console.error('❌ Failed to parse invalid backslash escapes:', e);
}

const doubleKey = '{"name": "name": "create_file", "arguments": {"path": "b.txt"}}';
console.log('\nTesting double key hallucination...');
try {
    const result = robustParseJSON(doubleKey);
    console.log('Successfully parsed:', JSON.stringify(result, null, 2));
    if (result.name === 'create_file') {
        console.log('✅ Double key test passed!');
    } else {
        console.error('❌ Result name is incorrect:', result.name);
    }
} catch (e) {
    console.error('❌ Failed to parse double key:', e);
}

const unquotedArgs = '{"name":"Read",arguments:{"file_path":"test.ts","limit":100}}';
console.log('\nTesting unquoted arguments key...');
try {
    const result = robustParseJSON(unquotedArgs);
    console.log('Successfully parsed:', JSON.stringify(result, null, 2));
    if (result.arguments && result.arguments.limit === 100) {
        console.log('✅ Unquoted arguments test passed!');
    } else {
        console.error('❌ Result structure is incorrect');
    }
} catch (e) {
    console.error('❌ Failed to parse unquoted arguments:', e);
}
