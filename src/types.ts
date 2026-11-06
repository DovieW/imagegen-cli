export type Provider =
  | "openai"
  | "google"
  | "microsoft"
  | "meta"
  | "bfl"
  | "fal"
  | "xai";
export type SettingValue =
  | string
  | number
  | boolean
  | { [key: string]: SettingValue };
export type Settings = Record<string, SettingValue>;
export interface BatchRow {
  prompt: string;
  model: string;
  provider?: Provider;
  references?: string[];
  mask?: string;
  markup?: string;
  parentIds?: string[];
  settings?: Settings;
  count?: number;
}
export interface BatchSpec {
  schemaVersion: 1;
  name: string;
  rows: BatchRow[];
  matrix?: {
    prompts: string[];
    models: string[];
    settings?: Settings[];
    references?: string[];
    count?: number;
  };
}
export type Status =
  | "queued"
  | "submitting"
  | "running"
  | "downloading"
  | "completed"
  | "failed"
  | "uncertain"
  | "paused"
  | "cancelled";
export interface Remote {
  id: string;
  statusUrl: string;
  resultUrl: string;
  cancelUrl?: string;
}
export interface Output {
  file: string;
  hash: string;
  bytes: number;
  mime: string;
}
export interface Job {
  id: string;
  prompt: string;
  model: string;
  provider: Provider;
  settings: Settings;
  references: string[];
  mask?: string;
  markup?: string;
  parentIds: string[];
  status: Status;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  remote?: Remote;
  results?: string[];
  outputs: Output[];
  usage?: unknown;
  svgUsage?: unknown;
  effectiveSettings?: Settings;
  errorCode?: string;
  preview?: { path: string; index: number; updatedAt: string };
  requestId?: string;
}
export interface Batch {
  requestKey?: string;
  specHash?: string;
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  jobs: Job[];
}
export interface ImageRecord {
  schemaVersion: 1;
  id: string;
  jobId: string;
  batchId: string;
  batchName: string;
  prompt: string;
  model: string;
  provider: Provider;
  settings: Settings;
  parentIds: string[];
  references: string[];
  mask?: string;
  markup?: string;
  createdAt: string;
  file: string;
  hash: string;
  bytes: number;
  mime: string;
  tags: string[];
  favorite: boolean;
  usage?: unknown;
  svgUsage?: unknown;
  effectiveSettings?: Settings;
  requestId?: string;
}
export interface ImageEntry extends ImageRecord {
  path: string;
  metadataPath: string;
}
