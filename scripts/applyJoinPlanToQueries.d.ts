export interface JoinTreeNode {
    operation: string;
    children: JoinTreeNode[];
}
export interface MetadataEntry {
    joinPlanCentralized: JoinTreeNode;
    [key: string]: any;
}
export declare function processQueries(metadataPath: string, queriesPath: string, outputPath: string): Promise<void>;
export declare function createBgpPattern(triples: any[]): any;
export declare function createGroupPattern(patterns: any[]): any;
export declare function createUnionPattern(patterns: any[]): any;
