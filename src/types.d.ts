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
  /**
   * Present for a bundled submission: eTranslation answers one delivery per
   * target language and they all share a single externalReference, so the
   * language travels with the result. Forwarded by @@translate-callback.
   */
  language?: string;
};

export type SubmitGroup = {
  /** obj_url of the object whose group is being submitted. */
  key: string;
  /**
   * Set when a submission was requeued (quota or capacity). The group record
   * was already closed, so the payload has to ride along with the job.
   */
  payload?: {
    obj_url: string;
    obj_uid: string;
    serial_id: number;
    html: string;
    langs: string[];
    sha: string;
    queued_at: number;
    /** Retries after an unexpected failure; see ETL_SUBMIT_MAX_ATTEMPTS. */
    attempt?: number;
  };
};

export type MoveInfo = {
  oldName: string;
  newName: string;
  oldParent: string;
  newParent: string;
  expected_uid?: string;
};

export type DeleteTranslation = {
  uids: string[];
};
