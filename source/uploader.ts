// :copyright: Copyright (c) 2023 ftrack

import loglevel from "loglevel";
import { Event, operation } from "./index.js";
import { SERVER_LOCATION_ID } from "./constant.js";
import { CreateComponentError } from "./error.js";
import { Session } from "./session.js";
import { v4 as uuidV4 } from "uuid";
import {
  CreateComponentOptions,
  CreateResponse,
  GetUploadMetadataResponse,
  MultiPartUploadPart,
} from "./types.js";
import normalizeString from "./util/normalize_string.js";
import { splitFileExtension } from "./util/split_file_extension.js";
import type { Data } from "./types.js";
import { getChunkSize } from "./util/get_chunk_size.js";

const logger = loglevel.getLogger("ftrack_api");

const wait = (milliseconds: number) =>
  new Promise((fn: (args: void) => void) => setTimeout(fn, milliseconds));

interface UploaderOptions extends CreateComponentOptions {
  onError?: (error: Error) => unknown;
  onComplete?: (componentId: string) => unknown;
}
export class Uploader {
  /** Component id */
  componentId: string;
  /** Session instance */
  private session: Session;
  /** File to upload */
  private file: Blob;
  /** Called on upload progress with percentage */
  private onProgress: UploaderOptions["onProgress"];
  /** Called when upload is aborted */
  private onAborted: UploaderOptions["onAborted"];
  /** Called on error */
  private onError: UploaderOptions["onError"];
  /** Called on upload completion */
  private onComplete: UploaderOptions["onComplete"];
  /** XHR for single-part upload. @deprecated */
  private xhr?: XMLHttpRequest;
  /** File type / extension */
  private fileType: string;
  /** File name */
  private fileName: string;
  /** File size in bytes */
  private fileSize: number;
  /** Number of parts for multi-part upload, or null for single-part upload */
  private numParts: number | null;
  /** Upload chunk (part) size in bytes */
  private chunkSize: number;
  /** Map of active XHR instances */
  private activeConnections: Record<number, XMLHttpRequest>;
  /** Maximum number of concurrent connections */
  private maxConcurrentConnections: number;
  /** URLs to for multi-part uploads */
  private parts: MultiPartUploadPart[];
  /** Completed parts */
  private uploadedParts: { e_tag: string; part_number: number }[];
  /** Server id for multi-part upload */
  private uploadId: string;
  /** Uploaded size */
  private uploadedSize: number;
  /** Number of bytes uploads */
  private progressCache: Record<number, number>;

  /** Number of milliseconds a request can take before automatically being terminated. The default value is 0, which means there is no timeout. */
  private timeout: number;
  /** Additional data for Component entity */
  private data: CreateComponentOptions["data"];
  /** @deprecated - Remove once Session.createComponent signature is updated. */
  createComponentResponse: CreateResponse<Data> | null;
  /** @deprecated - Remove once Session.createComponent signature is updated. */
  uploadMetadata: GetUploadMetadataResponse | null;
  /** @deprecated - Remove once Session.createComponent signature is updated. */
  createComponentLocationResponse: CreateResponse<Data> | null;

  constructor(session: Session, file: Blob, options: UploaderOptions) {
    this.session = session;
    this.file = file;
    const componentName = options.name ?? (file as File).name;
    let normalizedFileName;
    if (componentName) {
      normalizedFileName = normalizeString(componentName);
    }
    if (!normalizedFileName) {
      throw new CreateComponentError("Component name is missing.");
    }

    const fileNameParts = splitFileExtension(normalizedFileName);

    this.data = options.data || {};
    this.xhr = options.xhr;
    this.onProgress = options.onProgress;
    this.onAborted = options.onAborted;
    this.onError = options.onError;
    this.onComplete = options.onComplete;

    this.fileType = this.data.file_type || fileNameParts[1];
    this.fileName = this.data.name || fileNameParts[0];
    this.fileSize = this.data.size || file.size;

    this.componentId = this.data.id || uuidV4();

    this.maxConcurrentConnections = 6;
    this.chunkSize = getChunkSize(this.fileSize);
    this.numParts = Math.ceil(this.fileSize / this.chunkSize);
    if (this.numParts <= 2) {
      this.numParts = null;
    }
    if (this.xhr) {
      logger.warn(
        "[session.createComponent] options.xhr is deprecated and not compatible with multi-part uploads, use options.signal for aborting uploads."
      );
      this.numParts = null;
    }
    this.activeConnections = {};
    this.parts = [];
    this.uploadId = "";
    this.uploadedParts = [];
    this.uploadedSize = 0;
    this.progressCache = {};
    this.timeout = 0;

    this.createComponentResponse = null;
    this.uploadMetadata = null;
    this.createComponentLocationResponse = null;

    const handleAbortSignal = () => {
      this.abort();
      options.signal?.removeEventListener("abort", handleAbortSignal);
    };
    options.signal?.addEventListener("abort", handleAbortSignal);
  }

  async start() {
    logger.debug("Upload starting", this.componentId);
    await this.uploadPreflight();
    if (!this.uploadMetadata) {
      throw new Error("Failed to get upload metadata");
    }
    if ("urls" in this.uploadMetadata) {
      this.parts = this.uploadMetadata.urls;
      this.uploadId = this.uploadMetadata.upload_id;
      this.uploadNextChunk();
    } else {
      const { url, headers } = this.uploadMetadata;
      this.singlePartUpload({ url, headers });
    }
  }

  async uploadPreflight() {
    logger.debug("Registering component and fetching upload metadata.");

    const component = {
      ...this.data,
      id: this.componentId,
      name: this.fileName,
      file_type: this.fileType,
      size: this.fileSize,
    };
    const response = await this.session.call<
      [CreateResponse, GetUploadMetadataResponse]
    >([
      operation.create("FileComponent", component),
      {
        action: "get_upload_metadata",
        file_name: `${this.fileName}${this.fileType}`,
        file_size: this.fileSize,
        component_id: this.componentId,
        parts: this.numParts,
      },
    ]);

    this.createComponentResponse = response[0];
    this.uploadMetadata = response[1];
  }

  async singlePartUpload({
    url,
    headers,
  }: {
    url: string;
    headers: Record<string, string>;
  }) {
    try {
      await this.uploadFile({ url, headers });
      await this.completeUpload();
      logger.debug("Upload complete", this.componentId);
    } catch (error) {
      if (this.onError) {
        this.onError(error as Error);
      }
    }
  }

  handleSinglePartProgress(
    progressEvent: ProgressEvent<XMLHttpRequestEventTarget>
  ) {
    let progress = 0;

    if (progressEvent.lengthComputable) {
      progress = Math.floor((progressEvent.loaded / progressEvent.total) * 100);
    }
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }

  uploadNextChunk(retry = 0) {
    const activeConnections = Object.keys(this.activeConnections).length;

    if (activeConnections >= this.maxConcurrentConnections) {
      return;
    }

    if (!this.parts.length) {
      if (!activeConnections) {
        this.completeUpload();
      }

      return;
    }

    const part = this.parts.pop();
    if (this.file && part) {
      const sentSize = (part.part_number - 1) * this.chunkSize;
      const chunk = this.file.slice(sentSize, sentSize + this.chunkSize);

      const onUploadChunkStart = () => {
        this.uploadNextChunk();
      };

      this.uploadChunk(chunk, part, onUploadChunkStart)
        .then(() => {
          this.uploadNextChunk();
        })
        .catch((error) => {
          if (retry <= 6) {
            retry++;

            // Exponential back-off retry before giving up
            logger.warn(
              `Part#${part.part_number} failed to upload, backing off ${
                2 ** retry * 100
              } before retrying...`
            );
            wait(2 ** retry * 100).then(() => {
              this.parts.push(part);
              this.uploadNextChunk(retry);
            });
          } else {
            logger.error(
              `Part#${part.part_number} failed to upload, giving up`
            );
            const handleError = () => {
              if (this.onError) {
                this.onError(error);
              }
            };
            this.abort();
            this.cleanup().then(handleError, handleError);
          }
        });
    }
  }

  uploadChunk(
    chunk: Blob,
    part: MultiPartUploadPart,
    onUploadChunkStart: () => void
  ) {
    return new Promise<void>((resolve, reject) => {
      this.uploadFileChunk(chunk, part, onUploadChunkStart)
        .then((status) => {
          if (status !== 200) {
            reject(new Error("Failed chunk upload"));
            return;
          }

          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  }

  handleChunkProgress(partNumber: number, event: ProgressEvent) {
    if (this.file) {
      if (
        event.type === "progress" ||
        event.type === "error" ||
        event.type === "abort"
      ) {
        this.progressCache[partNumber] = event.loaded;
      }

      if (event.type === "uploaded") {
        this.uploadedSize += this.progressCache[partNumber] || 0;
        delete this.progressCache[partNumber];
      }

      const inProgress = Object.keys(this.progressCache)
        .map(Number)
        .reduce((memo, id) => (memo += this.progressCache[id]), 0);

      const sent = Math.min(this.uploadedSize + inProgress, this.fileSize);

      const total = this.fileSize;

      const percentage = Math.round((sent / total) * 100);
      if (this.onProgress) {
        this.onProgress(percentage);
      }
    }
  }

  uploadFileChunk(
    file: Blob,
    part: MultiPartUploadPart,
    onUploadChunkStart: () => void
  ) {
    // uploading each part with its pre-signed URL
    return new Promise((resolve, reject) => {
      const throwXHRError = (
        error: Error,
        part: MultiPartUploadPart,
        abortFx?: any
      ) => {
        delete this.activeConnections[part.part_number - 1];
        reject(error);
        window.removeEventListener("offline", abortFx);
      };
      if (true) {
        if (!window.navigator.onLine) {
          reject(new Error("System is offline"));
        }

        const xhr = (this.activeConnections[part.part_number - 1] =
          new XMLHttpRequest());
        xhr.timeout = this.timeout;
        onUploadChunkStart();

        const progressListener = this.handleChunkProgress.bind(
          this,
          part.part_number - 1
        );

        xhr.upload.addEventListener("progress", progressListener);

        xhr.addEventListener("error", progressListener);
        xhr.addEventListener("abort", progressListener);
        xhr.addEventListener("loadend", progressListener);

        xhr.open("PUT", part.signed_url);
        const abortXHR = () => xhr.abort();
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4 && xhr.status === 200) {
            const eTag = xhr.getResponseHeader("ETag");
            logger.debug(`Upload of part ${part.part_number} / ${this.numParts} complete`, eTag);
            if (eTag) {
              const uploadedPart = {
                part_number: part.part_number,
                e_tag: eTag.replaceAll('"', ""),
              };

              this.uploadedParts.push(uploadedPart);

              resolve(xhr.status);
              delete this.activeConnections[part.part_number - 1];
              window.removeEventListener("offline", abortXHR);
            }
          }
        };

        xhr.onerror = () => {
          throwXHRError(new Error("Upload chunk error"), part, abortXHR);
        };
        xhr.ontimeout = () => {
          throwXHRError(
            new Error("Upload chunk timeout timeout"),
            part,
            abortXHR
          );
        };
        xhr.onabort = () => {
          throwXHRError(new Error("Upload canceled by user or system"), part);
        };
        window.addEventListener("offline", abortXHR);
        xhr.send(file);
      }
    });
  }

  async uploadFile({
    url,
    headers,
  }: {
    url: string;
    headers: Record<string, string>;
  }) {
    logger.debug(`Uploading file to: ${url}`);

    const promise = new Promise((resolve, reject) => {
      this.xhr = this.xhr ?? new XMLHttpRequest();
      this.xhr.upload.addEventListener(
        "progress",
        this.handleSinglePartProgress.bind(this)
      );
      this.xhr.open("PUT", url, true);
      this.xhr.onabort = async () => {
        if (this.onAborted) {
          this.onAborted();
        }
        await this.cleanup();
        reject(
          new CreateComponentError("Upload aborted by client", "UPLOAD_ABORTED")
        );
      };
      this.xhr.onerror = async () => {
        await this.cleanup();
        reject(
          new CreateComponentError(`Failed to upload file: ${this.xhr!.status}`)
        );
      };
      this.xhr.onload = () => {
        if (this.xhr!.status >= 400) {
          reject(
            new CreateComponentError(
              `Failed to upload file: ${this.xhr!.status}`
            )
          );
        }
        resolve(this.xhr!.response);
      };

      for (const key in headers) {
        if (headers.hasOwnProperty(key) && key !== "Content-Length") {
          this.xhr.setRequestHeader(key, headers[key]);
        }
      }
      this.xhr.send(this.file);
    });

    await promise;
  }

  async completeUpload() {
    logger.debug("Completing upload");
    const operations = [];

    if (this.uploadedParts.length) {
      this.uploadedParts.sort((a, b) => a.part_number - b.part_number);
      operations.push({
        action: "complete_multipart_upload",
        upload_id: this.uploadId,
        // TODO: Remove map once API is snake_case
        parts: this.uploadedParts.map((item) => ({
          ETag: item.e_tag,
          PartNumber: item.part_number,
        })),
        component_id: this.componentId,
      });
    }

    operations.push(
      operation.create("ComponentLocation", {
        id: uuidV4(),
        component_id: this.componentId,
        resource_identifier: this.componentId,
        location_id: SERVER_LOCATION_ID,
      })
    );

    const response = await this.session.call<CreateResponse>(operations);
    this.createComponentLocationResponse = response[response.length - 1];

    // Emit event so that clients can perform additional work on uploaded
    // component (such as custom encoding).
    if (this.session.eventHub.isConnected()) {
      this.session.eventHub.publish(
        new Event("ftrack.location.component-added", {
          component_id: this.componentId,
          location_id: SERVER_LOCATION_ID,
        })
      );
    }

    if (this.onComplete) {
      this.onComplete(this.componentId);
    }
  }

  abort() {
    if (this.xhr) {
      this.xhr.abort();
    }

    Object.keys(this.activeConnections)
      .map(Number)
      .forEach((id) => {
        this.activeConnections[id].abort();
      });
  }

  async cleanup() {
    await this.session.delete("FileComponent", [this.componentId]);
  }
}
