export type AsyncFunction = (...args: any[]) => Promise<unknown>;

export type TypeJobsMapping = {
  [key: string]: AsyncFunction;
};

export type CallETranslation = {
  html: string;
  language: string;
  obj_url: string;
  serial_id: number;
  obj_uid?: string;
};

export type SaveTranslation = {
  obj_path: string;
  html: string;
};

export type MoveInfo = {
  oldName: string;
  newName: string;
  oldParent: string;
  newParent: string;
  langs?: string[];
  expected_uid?: string;
};
