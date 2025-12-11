const { exec } = require('child_process');

// Configuration
const DATABASE_BINDING = 'DB'; // Your D1 binding name
const QUERY = 'SELECT * FROM health_checks ORDER BY id DESC LIMIT 1';

/**
 * Helper to safely parse JSON strings that might be inside the DB columns.
 * Returns the parsed object or the original string if parsing fails.
 */
function safeParse(jsonString) {
    try {
        if (!jsonString) return null;
        return JSON.parse(jsonString);
    } catch (e) {
        return jsonString; // Return original if it's not valid JSON
    }
}

console.log(`\x1b[36mRunning D1 query on ${DATABASE_BINDING}...\x1b[0m`);

exec(`npx wrangler d1 execute ${DATABASE_BINDING} --remote --command="${QUERY}" --json`, (error, stdout, stderr) => {
    if (error) {
        console.error(`\x1b[31mExecution error:\x1b[0m ${error.message}`);
        return;
    }

    // Wrangler sometimes outputs logs to stderr, but we only care about real errors
    if (stderr && !stderr.includes('Executing on remote')) {
        // Optional: Log stderr if it seems critical, otherwise ignore verbose logs
        // console.warn(`stderr: ${stderr}`);
    }

    try {
        // 1. Parse the main Wrangler output
        const rawData = JSON.parse(stdout);

        // 2. Process the results to un-stringify nested JSON fields
        // D1 usually returns an array of result sets. We map over them.
        const processedData = rawData.map(resultSet => {
            if (!resultSet.results) return resultSet;

            // Map over the actual database rows
            const processedResults = resultSet.results.map(row => {
                // Create a copy so we don't mutate the original iterator issues
                const newRow = { ...row };

                // Parse 'steps_json' if it exists
                if (newRow.steps_json) {
                    newRow.steps_json = safeParse(newRow.steps_json);
                }

                // Parse 'ai_analysis_json' if it exists
                if (newRow.ai_analysis_json) {
                    newRow.ai_analysis_json = safeParse(newRow.ai_analysis_json);
                }

                return newRow;
            });

            return {
                ...resultSet,
                results: processedResults
            };
        });

        // 3. Pretty print the final processed object to the console
        console.log('\x1b[32m✔ Query successful. Processed Output:\x1b[0m\n');
        console.dir(processedData, { depth: null, colors: true });

    } catch (parseError) {
        console.error(`\x1b[31mFailed to parse output:\x1b[0m ${parseError.message}`);
        console.log('Raw output was:', stdout);
    }
});