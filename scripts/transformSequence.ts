import * as fs from 'fs';
import * as path from 'path';

interface Mappings {
    [regexStr: string]: string[]; // Regex string to CSV file path
}

interface LoadedPatterns {
    pattern: RegExp;
    replacements: string[];
}

/**
 * Reads a simple CSV file and extracts values as an array of strings.
 * Assumes a single column or comma-separated values on a single line.
 */
function loadCsvValues(csvPath: string): string[] {
    if (!fs.existsSync(csvPath)) {
        console.warn(`Warning: CSV file not found at ${csvPath}`);
        return [];
    }
    const content = fs.readFileSync(csvPath, 'utf-8');
    return content
        .split(/[\n,]+/)
        .map((val: string) => val.trim())
        .filter((val: string )=> val.length > 0);
}

/**
 * Loads the JSON configuration and parses the associated CSV files.
 */
function initializeMappings(jsonFilePath: string): LoadedPatterns[] {
    const rawData = fs.readFileSync(jsonFilePath, 'utf-8');
    const config: Mappings = JSON.parse(rawData);

    const loadedPatterns: LoadedPatterns[] = [];

    for (const [regexStr, csvPaths] of Object.entries(config)) {
        const loadedReplacements: string[] = []
        for (const csvPath of csvPaths){
            // Remove header
            const replacements = loadCsvValues(csvPath).slice(1);
            for (const replacement of replacements) {
                loadedReplacements.push(replacement);
            }        
        }
        loadedPatterns.push({
            pattern: new RegExp(regexStr, 'g'),
            replacements: loadedReplacements
        });

    }
    return loadedPatterns;
}


interface SequencePair {
    baseName: string;
    metadataFile?: string;
    sparqlFile?: string;
}

/**
 * Scans a directory and pairs .metadata.json and .sparql files.
 */
function getSequencePairs(directory: string): SequencePair[] {
    const files = fs.readdirSync(directory);
    const pairMap = new Map<string, SequencePair>();

    for (const file of files) {
        let baseName = '';
        let isMetadata = false;
        let isSparql = false;

        if (file.endsWith('.metadata.json')) {
            baseName = file.replace('.metadata.json', '');
            isMetadata = true;
        } else if (file.endsWith('.sparql')) {
            baseName = file.replace('.sparql', '');
            isSparql = true;
        } else {
            continue; // Skip irrelevant files
        }

        // Initialize the pair if it does not exist
        if (!pairMap.has(baseName)) {
            pairMap.set(baseName, { baseName });
        }

        const pair = pairMap.get(baseName)!;

        // Assign full paths
        if (isMetadata) {
            pair.metadataFile = path.join(directory, file);
        } else if (isSparql) {
            pair.sparqlFile = path.join(directory, file);
        }
    }

    // Filter and return only complete pairs
    return Array.from(pairMap.values()).filter(
        pair => pair.metadataFile && pair.sparqlFile
    );
}

/**
 * Selects a random replacement from the available options.
 */
function getRandomReplacement(replacements: string[]): string {
    const randomIndex = Math.floor(Math.random() * replacements.length);
    return replacements[randomIndex];
}

/**
 * Processes all sequence files in the target directory using the loaded patterns.
 */
function processSequences(jsonFilePath: string, inputDirectory: string, outputDirectory: string): void {
    const patterns = initializeMappings(jsonFilePath);

    if (!fs.existsSync(outputDirectory)) {
        fs.mkdirSync(outputDirectory, { recursive: true });
    }

    const pairedFiles = getSequencePairs(inputDirectory);

    for (const pair of pairedFiles) {
        console.log(`Processing: ${pair.baseName}`);
        
        const metadataRaw = fs.readFileSync(pair.metadataFile!, 'utf-8');
        const metadataJson = JSON.parse(metadataRaw);
        const metadataElements = metadataJson["sequenceElements"];
        const sparqlContent = fs.readFileSync(pair.sparqlFile!, 'utf-8').split("\n\n");
        
        let activeSessionId: number | null = null;
        const seenSessions = new Set<number>();

        for (let i = 0; i < metadataElements.length; i++) {
            const currentElement = metadataElements[i];
            const currentSessionId = currentElement.session.sessionId;

            if (currentSessionId !== activeSessionId) {
                if (!seenSessions.has(currentSessionId)) {
                    seenSessions.add(currentSessionId);
                    
                    let randomInitQuery = sparqlContent[i];
                    for (const { pattern, replacements } of patterns) {
                        randomInitQuery = randomInitQuery.replace(pattern, (matchedString: string) => {
                            return getRandomReplacement(replacements);
                        });
                    }

                    if (sparqlContent[i] === randomInitQuery) {
                        const snippet = sparqlContent[i].substring(0, 50).replace(/\n/g, ' ');
                        console.error(`Failed to transform query snippet: ${snippet}...`);
                        throw new Error(`No regex matches found for initialization in ${pair.baseName}`);
                    }
                    
                    sparqlContent[i] = randomInitQuery;
                } 
                activeSessionId = currentSessionId;
            }
        }

        // Define new paths
        const newBaseName = `${pair.baseName}_random_init`;
        const sparqlOutputPath = path.join(outputDirectory, `${newBaseName}.sparql`);
        const metadataOutputPath = path.join(outputDirectory, `${newBaseName}.metadata.json`);

        // Write new files
        fs.writeFileSync(sparqlOutputPath, sparqlContent.join("\n\n"), 'utf-8');
        fs.writeFileSync(metadataOutputPath, metadataRaw, 'utf-8');
        console.log(`Saved: ${newBaseName}`);

        // --- DELETE ORIGINAL FILES ---
        try {
            fs.unlinkSync(pair.metadataFile!);
            fs.unlinkSync(pair.sparqlFile!);
            console.log(`Deleted originals: ${pair.metadataFile} and ${pair.sparqlFile}`);
        } catch (err) {
            console.warn(`Warning: Could not delete original files for ${pair.baseName}:`, err);
        }
    }
}
// CLI Execution Handlers
const args = process.argv.slice(2);

function displayHelp(): void {
    console.log(`
Usage: node transformSequence.js --json <path> --sequences <path>

Options:
  --json     Path to the JSON mapping file
  --sequences    Path to the input directory containing sequence files
  --help     Display this help message
    `);
}

// Display help if requested
if (args.includes('--help') || args.includes('-h')) {
    displayHelp();
    process.exit(0);
}

// Parse named arguments
let jsonFile: string | undefined;
let inputDir: string | undefined;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonFile = args[++i];
    if (args[i] === '--sequences') inputDir = args[++i];
}

// Validate required arguments
if (!jsonFile || !inputDir) {
    console.error("Error: Missing required arguments.");
    displayHelp();
    process.exit(1);
}

try {
    processSequences(jsonFile, inputDir, inputDir);
} catch (error) {
    console.error("An error occurred during processing:", error);
}