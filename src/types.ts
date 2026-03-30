

export interface FileTagConfig {
  tags: Record<string, string[]>;
  views: Record<string, ViewCondition>;
}


export type ViewCondition =
  | string
  | string[]
  | { and: ViewCondition[] }
  | { or: ViewCondition[] }
  | { not: ViewCondition };


export interface ExtractedGlobs {
  include: string;
  exclude: string;
}
