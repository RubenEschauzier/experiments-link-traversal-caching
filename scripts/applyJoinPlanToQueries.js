"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processQueries = processQueries;
exports.createBgpPattern = createBgpPattern;
exports.createGroupPattern = createGroupPattern;
exports.createUnionPattern = createUnionPattern;
const fs = require("fs");
const parser_sparql_1_1_1 = require("@traqula/parser-sparql-1-1");
const generator_sparql_1_1_1 = require("@traqula/generator-sparql-1-1");
const utils_algebra_1 = require("@comunica/utils-algebra");
const path = require("path");
const parser = new parser_sparql_1_1_1.Parser();
const generator = new generator_sparql_1_1_1.Generator();
const DUMMY_LOC = { sourceLocationType: 'autoGenerate' };
async function processQueries(metadataPath, queriesPath, outputPath) {
    const metadataRaw = fs.readFileSync(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataRaw).sequenceElements;
    const queriesRaw = fs.readFileSync(queriesPath, 'utf-8');
    const queries = queriesRaw.split(/\n\s*\n/).filter(q => q.trim().length > 0);
    if (metadata.length !== queries.length) {
        console.warn(`Warning: Found ${metadata.length} metadata entries but ${queries.length} queries.`);
    }
    const processedQueries = [];
    for (let i = 0; i < Math.min(metadata.length, queries.length); i++) {
        const entry = metadata[i];
        const queryString = queries[i];
        if (!entry.joinPlanCentralized) {
            console.log(`Skipping query ${i}: No join plan found.`);
            continue;
        }
        const ast = parser.parse(queryString);
        const astPrefixes = {};
        for (const contextEntry of ast.context) {
            if (contextEntry.subType === 'prefix') {
                astPrefixes[contextEntry.key] = contextEntry.value.value;
            }
        }
        // Reverted back to your working visitor implementation
        const quadPatterns = [];
        const pathPatterns = [];
        utils_algebra_1.algebraUtils.visitOperation(ast, {
            [utils_algebra_1.Algebra.Types.PATTERN]: {
                visitor: (node) => {
                    if (node.subType === 'bgp' && Array.isArray(node.triples)) {
                        for (const triple of node.triples) {
                            if (triple.predicate?.type === 'path' || triple.subType === 'path') {
                                pathPatterns.push(triple);
                            }
                            else {
                                quadPatterns.push(triple);
                            }
                        }
                    }
                    else if (node.subType === 'path') {
                        pathPatterns.push(node);
                    }
                    return node;
                },
            },
        });
        const scanToPattern = new Map();
        matchTriplePatterns(scanToPattern, entry.joinPlanCentralized, quadPatterns, pathPatterns, astPrefixes);
        ast.where.patterns = reorderScope(ast.where.patterns, entry.joinPlanCentralized, scanToPattern);
        const dummyHintQuery = `PREFIX comunica: <http://comunica-internal> SELECT * WHERE { comunica:hint comunica:optimizer "None" . }`;
        const hintAst = parser.parse(dummyHintQuery);
        const hintPattern = hintAst.where.patterns.find((p) => p.type === 'pattern' && p.subType === 'bgp');
        if (hintPattern && hintPattern.triples.length > 0) {
            // Force the generator to output the exact bare word if required by the engine
            ast.where.patterns.unshift(hintPattern);
        }
        processedQueries.push(generator.generate(ast));
    }
    fs.writeFileSync(outputPath, processedQueries.join('\n\n'), 'utf-8');
}
/**
 * Reorders elements within a specific AST scope. Preserves the logical
 * evaluation order of non-joinable elements (BIND, FILTER) by interleaving
 * them based on their original sequence relative to the generated join subtrees.
 */
function reorderScope(patterns, planRoot, scanToPattern) {
    const elements = new Set();
    const nonTripleElements = [];
    const elemToTriples = new Map();
    const originalIndexMap = new Map();
    // 1. Isolate and prepare elements, assigning original sequence indices
    patterns.forEach((p, i) => {
        originalIndexMap.set(p, i);
        if (p.subType === 'bgp') {
            p.triples.forEach((t) => {
                elements.add(t);
                elemToTriples.set(t, new Set([t]));
                originalIndexMap.set(t, i);
            });
        }
        else {
            if (p.patterns && (p.subType === 'optional' || p.subType === 'group')) {
                p.patterns = reorderScope(p.patterns, planRoot, scanToPattern);
            }
            else if (p.subType === 'union') {
                p.patterns = p.patterns.map((branch) => {
                    if (branch.patterns) {
                        branch.patterns = reorderScope(branch.patterns, planRoot, scanToPattern);
                        return branch;
                    }
                    else if (branch.subType === 'bgp') {
                        const inner = reorderScope([{ type: 'pattern', subType: 'bgp', triples: branch.triples }], planRoot, scanToPattern);
                        return inner.length === 1 ? inner[0] : createGroupPattern(inner);
                    }
                    return branch;
                });
            }
            const constituentTriples = collectAllTriples([p]);
            if (constituentTriples.length === 0) {
                nonTripleElements.push({ node: p, idx: i });
            }
            else {
                elements.add(p);
                elemToTriples.set(p, new Set(constituentTriples));
            }
        }
    });
    // 2. Project the QLever tree onto the elements
    function buildJoinTree(node) {
        const isScan = /IndexScan/.test(node.operation);
        const isTransitive = /TransitivePath/.test(node.operation);
        let currentMatch = null;
        if (isScan || isTransitive) {
            const t = scanToPattern.get(node);
            if (t && elements.has(t)) {
                elements.delete(t);
                currentMatch = t;
            }
            if (isScan)
                return currentMatch;
        }
        const childResults = node.children.map(buildJoinTree).filter(x => x !== null);
        const completedComplex = [];
        for (const el of Array.from(elements)) {
            if ((el.subType === 'optional' && node.operation.includes('OptionalJoin')) ||
                (el.subType === 'union' && node.operation.includes('Union'))) {
                if (subtreeContainsTriples(node, elemToTriples.get(el), scanToPattern)) {
                    elements.delete(el);
                    completedComplex.push(el);
                }
            }
        }
        const allItems = [];
        if (currentMatch)
            allItems.push(currentMatch);
        allItems.push(...childResults, ...completedComplex);
        if (allItems.length === 0)
            return null;
        if (allItems.length === 1)
            return allItems[0];
        // Use structural check instead of fragile subType check
        const triples = allItems.filter(c => isTriple(c));
        const complex = allItems.filter(c => !isTriple(c));
        const parts = [];
        if (triples.length > 0)
            parts.push(createBgpPattern(triples));
        for (const c of complex) {
            parts.push(c.subType === 'bgp' ? createGroupPattern([c]) : c);
        }
        return parts.length === 1 ? parts[0] : createGroupPattern(parts);
    }
    const generatedTree = buildJoinTree(planRoot);
    // 3. Unpack top-level branches and resolve execution order
    let branches = [];
    if (generatedTree) {
        if (generatedTree.subType === 'group') {
            branches = [...generatedTree.patterns];
        }
        else if (isTriple(generatedTree)) {
            branches = [createBgpPattern([generatedTree])];
        }
        else {
            branches = [generatedTree];
        }
    }
    // Use structural check for fallback
    const unmappedRaw = Array.from(elements).filter((e) => isTriple(e));
    const unmappedComplex = Array.from(elements).filter((e) => !isTriple(e));
    if (unmappedRaw.length > 0)
        branches.push(createBgpPattern(unmappedRaw));
    branches.push(...unmappedComplex);
    function getMinIndex(node) {
        if (!node)
            return Infinity;
        if (originalIndexMap.has(node))
            return originalIndexMap.get(node);
        let min = Infinity;
        if (node.triples)
            node.triples.forEach((t) => { min = Math.min(min, getMinIndex(t)); });
        if (node.patterns)
            node.patterns.forEach((p) => { min = Math.min(min, getMinIndex(p)); });
        return min;
    }
    const branchesWithIdx = branches.map(b => ({
        node: b,
        idx: getMinIndex(b)
    }));
    const combined = [...branchesWithIdx, ...nonTripleElements];
    combined.sort((a, b) => a.idx - b.idx);
    return combined.map(item => item.node);
}
// --- Join Evaluation Utilities ---
function isTriple(e) {
    // Robust structural check to accurately separate raw triples from patterns
    return e && typeof e === 'object' && 'subject' in e && 'predicate' in e && 'object' in e;
}
function collectAllTriples(patterns) {
    const triples = [];
    for (const p of patterns) {
        if (!p)
            continue;
        if (isTriple(p)) {
            triples.push(p);
        }
        else if (p.subType === 'bgp' || p.subType === 'path') {
            if (p.triples)
                triples.push(...p.triples);
            else
                triples.push(p);
        }
        else if (p.patterns) {
            triples.push(...collectAllTriples(p.patterns));
        }
        else if (p.triples) {
            triples.push(...p.triples);
        }
    }
    return triples;
}
function subtreeContainsTriples(node, triples, scanToPattern) {
    let found = false;
    function check(n) {
        if (found)
            return;
        const t = scanToPattern.get(n);
        if (t && triples.has(t)) {
            found = true;
            return;
        }
        n.children.forEach(check);
    }
    check(node);
    return found;
}
// --- Pattern Constructors ---
function createBgpPattern(triples) {
    return { type: 'pattern', subType: 'bgp', triples, loc: DUMMY_LOC };
}
function createGroupPattern(patterns) {
    return { type: 'pattern', subType: 'group', patterns, loc: DUMMY_LOC };
}
function createUnionPattern(patterns) {
    return { type: 'pattern', subType: 'union', patterns, loc: DUMMY_LOC };
}
// --- Triple & Path Matching Logic ---
function matchTriplePatterns(scanToPattern, joinPlan, quadPatterns, pathPatterns, prefixes) {
    joinPlan.children.forEach(child => matchTriplePatterns(scanToPattern, child, quadPatterns, pathPatterns, prefixes));
    const matchScan = /IndexScan\s+([A-Z]{3})/.exec(joinPlan.operation);
    if (matchScan) {
        const algebraPattern = parseTriple(joinPlan.operation.split(matchScan[0])[1]);
        let found = quadPatterns.find(p => isPatternEqual(p, algebraPattern, prefixes));
        if (!found) {
            found = pathPatterns.find(p => isTermEqual(p.subject, algebraPattern.subject, prefixes) &&
                isTermEqual(p.object, algebraPattern.object, prefixes));
        }
        if (found)
            scanToPattern.set(joinPlan, found);
        return;
    }
    const matchPath = /TransitivePath/.exec(joinPlan.operation);
    if (matchPath) {
        const algebraPattern = parseTriple(joinPlan.operation.split(matchPath[0])[1]);
        const found = pathPatterns.find(p => isEqualPathPattern(p, algebraPattern, prefixes));
        if (found)
            scanToPattern.set(joinPlan, found);
    }
}
function getPathIri(predicate) {
    if (!predicate)
        return null;
    if (predicate.value)
        return predicate.value;
    if (predicate.iri && predicate.iri.value)
        return predicate.iri.value;
    if (predicate.items && predicate.items.length > 0)
        return getPathIri(predicate.items[0]);
    if (predicate.path)
        return getPathIri(predicate.path);
    return null;
}
function isEqualPathPattern(pathPattern, qLeverPattern, prefixes) {
    const pathIri = getPathIri(pathPattern.predicate) || getPathIri(pathPattern.path);
    const qLeverIri = getExpandedValue(qLeverPattern.predicate, prefixes);
    return isTermEqual(pathPattern.subject, qLeverPattern.subject, prefixes) &&
        isTermEqual(pathPattern.object, qLeverPattern.object, prefixes) &&
        (pathIri && qLeverIri ? qLeverIri.endsWith(pathIri) || pathIri.endsWith(qLeverIri) : false);
}
function parseTriple(tripleString) {
    const dummyQuery = `SELECT * WHERE { ${tripleString} . }`;
    try {
        const ast = parser.parse(dummyQuery);
        const wherePatterns = ast.where?.patterns || ast.where || [];
        const bgpNode = wherePatterns.find((p) => p.type === 'pattern' && p.subType === 'bgp');
        if (bgpNode?.triples?.length > 0)
            return bgpNode.triples[0];
        throw new Error('Valid AST generated, but no BGP or triples found.');
    }
    catch (error) {
        throw new Error(`Failed to parse triple string '${tripleString}': ${error}`);
    }
}
function isPatternEqual(p1, p2, prefixes) {
    return isTermEqual(p1.subject, p2.subject, prefixes) &&
        isTermEqual(p1.predicate, p2.predicate, prefixes) &&
        isTermEqual(p1.object, p2.object, prefixes) &&
        isTermEqual(p1.graph, p2.graph, prefixes);
}
function getExpandedValue(term, prefixes) {
    if (term.subType === 'namedNode' && term.prefix && prefixes[term.prefix]) {
        return prefixes[term.prefix] + term.value;
    }
    return term.value;
}
function isTermEqual(t1, t2, prefixes) {
    if (!t1 && !t2)
        return true;
    return t1.subType === t2.subType &&
        getExpandedValue(t1, prefixes) === getExpandedValue(t2, prefixes);
}
async function processDirectory(directoryPath) {
    const files = fs.readdirSync(directoryPath);
    const sparqlFiles = files.filter(file => file.endsWith('.sparql'));
    for (const sparqlFile of sparqlFiles) {
        const baseName = sparqlFile.replace('.sparql', '');
        const metadataFile = `${baseName}.metadata.json`;
        const sparqlPath = path.join(directoryPath, sparqlFile);
        const metadataPath = path.join(directoryPath, metadataFile);
        if (fs.existsSync(metadataPath)) {
            console.log(`Processing ${sparqlFile}...`);
            console.log(`Metadata: ${metadataPath}`);
            await processQueries(metadataPath, sparqlPath, sparqlPath);
        }
        else {
            console.warn(`Skipping ${sparqlFile}: Metadata file not found.`);
        }
    }
}
const targetDirectory = 'generated/out-queries';
processDirectory(targetDirectory).catch(console.error);
// const metadataFile = 'generated/out-queries/sequence_5.metadata.json';
// const queriesFile = 'generated/out-queries/sequence_5.sparql';
// const outputFile = 'test.sparql';
// processQueries(metadataFile, queriesFile, outputFile);
//# sourceMappingURL=applyJoinPlanToQueries.js.map