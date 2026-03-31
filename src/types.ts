

export interface FileTagConfig {
  tags: Record<string, string[]>;
  views: Record<string, ViewCondition>;
}


export type ViewCondition =
  | string
  | string[]
  | { union: ViewCondition[] }
  | { intersect: ViewCondition[] }
  | { subtract: { include: ViewCondition; exclude: ViewCondition } }
  | { from: string | string[]; exclude?: string | string[] }
  | { and: ViewCondition[] }
  | { or: ViewCondition[] }
  | { not: ViewCondition };


export type TagSetExpression =
  | { kind: "tags"; tags: string[] }
  | { kind: "union"; nodes: TagSetExpression[] }
  | { kind: "intersect"; nodes: TagSetExpression[] }
  | { kind: "subtract"; include: TagSetExpression; exclude: TagSetExpression }
  | { kind: "fromExclude"; include: string[]; exclude: string[] }
  | { kind: "all" };


export interface ExtractedGlobs {
  include: string;
  exclude: string;
}
