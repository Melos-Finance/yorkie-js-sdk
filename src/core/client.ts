/*
 * Copyright 2020 The Yorkie Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ActorID } from '@yorkie-js-sdk/src/document/time/actor_id';
import {
  Observer,
  Observable,
  createObservable,
  Unsubscribe,
  ErrorFn,
  CompleteFn,
  NextFn,
} from '@yorkie-js-sdk/src/util/observable';
import {
  ActivateClientRequest,
  DeactivateClientRequest,
  AttachDocumentRequest,
  DetachDocumentRequest,
  PushPullRequest,
  WatchDocumentsRequest,
  WatchDocumentsResponse,
  UpdatePresenceRequest,
} from '@yorkie-js-sdk/src/api/yorkie/v1/yorkie_pb';
import { DocEventType } from '@yorkie-js-sdk/src/api/yorkie/v1/resources_pb';
import { converter } from '@yorkie-js-sdk/src/api/converter';
import { YorkieServiceClient as RPCClient } from '@yorkie-js-sdk/src/api/yorkie/v1/yorkie_grpc_web_pb';
import { Code, YorkieError } from '@yorkie-js-sdk/src/util/error';
import { logger } from '@yorkie-js-sdk/src/util/logger';
import { uuid } from '@yorkie-js-sdk/src/util/uuid';
import { Document } from '@yorkie-js-sdk/src/document/document';
import {
  AuthUnaryInterceptor,
  AuthStreamInterceptor,
} from '@yorkie-js-sdk/src/core/auth';
import type { Indexable } from '@yorkie-js-sdk/src/document/document';

/**
 * `ClientStatus` is client status types
 * @public
 */
export enum ClientStatus {
  /**
   * client deactivated status
   */
  Deactivated = 'deactivated',
  /**
   * client activated status
   */
  Activated = 'activated',
}

/**
 * `StreamConnectionStatus` is stream connection status types
 * @public
 */
export enum StreamConnectionStatus {
  /**
   * stream connected
   */
  Connected = 'connected',
  /**
   * stream disconnected
   */
  Disconnected = 'disconnected',
}

/**
 * `DocumentSyncResultType` is document sync result types
 * @public
 */
export enum DocumentSyncResultType {
  /**
   * type when Document synced.
   */
  Synced = 'synced',
  /**
   * type when Document sync failed.
   */
  SyncFailed = 'sync-failed',
}

/**
 * `ClientEventType` is client event types
 * @public
 */
export enum ClientEventType {
  /**
   * client event type when status changed.
   */
  StatusChanged = 'status-changed',
  /**
   * client event type when documents changed.
   */
  DocumentsChanged = 'documents-changed',
  /**
   * client event type when peers changed.
   */
  PeersChanged = 'peers-changed',
  /**
   * client event type when stream connection changed.
   */
  StreamConnectionStatusChanged = 'stream-connection-status-changed',
  /**
   * client event type when document synced.
   */
  DocumentSynced = 'document-synced',
}

/**
 * `ClientEvent` is an event that occurs in `Client`. It can be delivered using
 * `Client.subscribe()`.
 *
 * @public
 */
export type ClientEvent<P = Indexable> =
  | StatusChangedEvent
  | DocumentsChangedEvent
  | PeersChangedEvent<P>
  | StreamConnectionStatusChangedEvent
  | DocumentSyncedEvent;

/**
 * @internal
 */
export interface BaseClientEvent {
  type: ClientEventType;
}

/**
 * `StatusChangedEvent` is an event that occurs when the Client's state changes.
 *
 * @public
 */
export interface StatusChangedEvent extends BaseClientEvent {
  /**
   * enum {@link ClientEventType}.StatusChanged
   */
  type: ClientEventType.StatusChanged;
  /**
   * `DocumentsChangedEvent` value
   */
  value: ClientStatus;
}

/**
 * `DocumentsChangedEvent` is an event that occurs when documents attached to
 * the client changes.
 *
 * @public
 */
export interface DocumentsChangedEvent extends BaseClientEvent {
  /**
   * enum {@link ClientEventType}.DocumentsChangedEvent
   */
  type: ClientEventType.DocumentsChanged;
  /**
   * `DocumentsChangedEvent` value
   */
  value: Array<string>;
}

/**
 * `PeersChangedEvent` is an event that occurs when the states of another peers
 * of the attached documents changes.
 *
 * @public
 */
export interface PeersChangedEvent<P> extends BaseClientEvent {
  /**
   * enum {@link ClientEventType}.PeersChangedEvent
   */
  type: ClientEventType.PeersChanged;
  /**
   * `PeersChangedEvent` value
   */
  value: Record<string, Record<string, P>>;
}

/**
 * `StreamConnectionStatusChangedEvent` is an event that occurs when
 * the client's stream connection state changes.
 *
 * @public
 */
export interface StreamConnectionStatusChangedEvent extends BaseClientEvent {
  /**
   * `StreamConnectionStatusChangedEvent` type
   * enum {@link ClientEventType}.StreamConnectionStatusChangedEvent
   */
  type: ClientEventType.StreamConnectionStatusChanged;
  /**
   * `StreamConnectionStatusChangedEvent` value
   */
  value: StreamConnectionStatus;
}

/**
 * `DocumentSyncedEvent` is an event that occurs when documents
 * attached to the client are synced.
 *
 * @public
 */
export interface DocumentSyncedEvent extends BaseClientEvent {
  /**
   * `DocumentSyncedEvent` type
   * enum {@link ClientEventType}.DocumentSyncedEvent
   */
  type: ClientEventType.DocumentSynced;
  /**
   * `DocumentSyncedEvent` value
   */
  value: DocumentSyncResultType;
}

interface Attachment<P> {
  doc: Document<unknown>;
  isRealtimeSync: boolean;
  peerPresenceMap?: Map<string, PresenceInfo<P>>;
  remoteChangeEventReceived?: boolean;
}

/**
 * `PresenceInfo` is presence information of this client.
 *
 * @public
 */
export type PresenceInfo<P> = {
  clock: number;
  data: P;
};

/**
 * `ClientOptions` are user-settable options used when defining clients.
 *
 * @public
 */
export interface ClientOptions<P> {
  /**
   * `key` is the client key. It is used to identify the client.
   * If not set, a random key is generated.
   */
  key?: string;

  /**
   * `presence` is the presence information of this client. If the client
   * attaches a document, the presence information is sent to the other peers
   * attached to the document.
   */
  presence?: P;

  /**
   * `apiKey` is the API key of the project. It is used to identify the project.
   * If not set, API key of the default project is used.
   */
  apiKey?: string;

  /**
   * `token` is the authentication token of this client. It is used to identify
   * the user of the client.
   */
  token?: string;

  /**
   * `syncLoopDuration` is the duration of the sync loop. After each sync loop,
   * the client waits for the duration to next sync. The default value is
   * `50`(ms).
   */
  syncLoopDuration?: number;

  /**
   * `reconnectStreamDelay` is the delay of the reconnect stream. If the stream
   * is disconnected, the client waits for the delay to reconnect the stream. The
   * default value is `1000`(ms).
   */
  reconnectStreamDelay?: number;
}

/**
 * `DefaultClientOptions` is the default options for Client.
 */
const DefaultClientOptions = {
  syncLoopDuration: 50,
  reconnectStreamDelay: 1000,
};

/**
 * `Client` is a normal client that can communicate with the server.
 * It has documents and sends changes of the documents in local
 * to the server to synchronize with other replicas in remote.
 *
 * @public
 */
export class Client<P = Indexable> implements Observable<ClientEvent<P>> {
  private id?: ActorID;
  private key: string;
  private presenceInfo: PresenceInfo<P>;
  private status: ClientStatus;
  private attachmentMap: Map<string, Attachment<P>>;
  private syncLoopDuration: number;
  private reconnectStreamDelay: number;

  private rpcClient: RPCClient;
  private watchLoopTimerID?: ReturnType<typeof setTimeout>;
  private remoteChangeEventStream?: any;
  private eventStream: Observable<ClientEvent<P>>;
  private eventStreamObserver!: Observer<ClientEvent<P>>;

  /**
   * @param rpcAddr - the address of the RPC server.
   * @param opts - the options of the client.
   */
  constructor(rpcAddr: string, opts?: ClientOptions<P>) {
    opts = opts || DefaultClientOptions;

    this.key = opts.key ? opts.key : uuid();
    this.presenceInfo = {
      clock: 0,
      data: opts.presence ? opts.presence : ({} as P),
    };
    this.status = ClientStatus.Deactivated;
    this.attachmentMap = new Map();
    this.syncLoopDuration =
      opts.syncLoopDuration || DefaultClientOptions.syncLoopDuration;
    this.reconnectStreamDelay =
      opts.reconnectStreamDelay || DefaultClientOptions.reconnectStreamDelay;

    let rpcOpts;
    if (opts.apiKey || opts.token) {
      rpcOpts = {
        unaryInterceptors: [new AuthUnaryInterceptor(opts.apiKey, opts.token)],
        streamInterceptors: [
          new AuthStreamInterceptor(opts.apiKey, opts.token),
        ],
      };
    }

    this.rpcClient = new RPCClient(rpcAddr, null, rpcOpts);
    this.eventStream = createObservable<ClientEvent<P>>((observer) => {
      this.eventStreamObserver = observer;
    });
  }

  /**
   * `ativate` activates this client. That is, it register itself to the server
   * and receives a unique ID from the server. The given ID is used to
   * distinguish different clients.
   */
  public activate(): Promise<void> {
    if (this.isActive()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const req = new ActivateClientRequest();
      req.setClientKey(this.key);

      this.rpcClient.activateClient(req, {}, (err, res) => {
        if (err) {
          logger.error(`[AC] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        this.id = converter.toHexString(res.getClientId_asU8());
        this.status = ClientStatus.Activated;
        this.runSyncLoop();
        this.runWatchLoop();

        this.eventStreamObserver.next({
          type: ClientEventType.StatusChanged,
          value: this.status,
        });

        logger.info(`[AC] c:"${this.getKey()}" activated, id:"${this.id}"`);
        resolve();
      });
    });
  }

  /**
   * `deactivate` deactivates this client.
   */
  public deactivate(): Promise<void> {
    if (this.status === ClientStatus.Deactivated) {
      return Promise.resolve();
    }

    if (this.remoteChangeEventStream) {
      this.remoteChangeEventStream.cancel();
      this.remoteChangeEventStream = undefined;
    }

    return new Promise((resolve, reject) => {
      const req = new DeactivateClientRequest();
      req.setClientId(converter.toUint8Array(this.id!));

      this.rpcClient.deactivateClient(req, {}, (err) => {
        if (err) {
          logger.error(`[DC] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        this.status = ClientStatus.Deactivated;
        this.eventStreamObserver.next({
          type: ClientEventType.StatusChanged,
          value: this.status,
        });

        logger.info(`[DC] c"${this.getKey()}" deactivated`);
        resolve();
      });
    });
  }

  /**
   * `attach` attaches the given document to this client. It tells the server that
   * this client will synchronize the given document.
   */
  public attach(
    doc: Document<unknown>,
    isManualSync?: boolean,
  ): Promise<Document<unknown>> {
    if (!this.isActive()) {
      throw new YorkieError(Code.ClientNotActive, `${this.key} is not active`);
    }

    doc.setActor(this.id!);

    return new Promise((resolve, reject) => {
      const req = new AttachDocumentRequest();
      req.setClientId(converter.toUint8Array(this.id!));
      req.setChangePack(converter.toChangePack(doc.createChangePack()));

      this.rpcClient.attachDocument(req, {}, (err, res) => {
        if (err) {
          logger.error(`[AD] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        const pack = converter.fromChangePack(res.getChangePack()!);
        doc.applyChangePack(pack);

        this.attachmentMap.set(doc.getKey(), {
          doc,
          isRealtimeSync: !isManualSync,
          peerPresenceMap: new Map(),
        });
        this.runWatchLoop();

        logger.info(`[AD] c:"${this.getKey()}" attaches d:"${doc.getKey()}"`);
        resolve(doc);
      });
    });
  }

  /**
   * `detach` detaches the given document from this client. It tells the
   * server that this client will no longer synchronize the given document.
   *
   * To collect garbage things like CRDT tombstones left on the document, all
   * the changes should be applied to other replicas before GC time. For this,
   * if the document is no longer used by this client, it should be detached.
   */
  public detach(doc: Document<unknown>): Promise<Document<unknown>> {
    if (!this.isActive()) {
      throw new YorkieError(Code.ClientNotActive, `${this.key} is not active`);
    }

    return new Promise((resolve, reject) => {
      const req = new DetachDocumentRequest();
      req.setClientId(converter.toUint8Array(this.id!));
      req.setChangePack(converter.toChangePack(doc.createChangePack()));

      this.rpcClient.detachDocument(req, {}, (err, res) => {
        if (err) {
          logger.error(`[DD] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        const pack = converter.fromChangePack(res.getChangePack()!);
        doc.applyChangePack(pack);

        if (this.attachmentMap.has(doc.getKey())) {
          this.attachmentMap.delete(doc.getKey());
        }
        this.runWatchLoop();

        logger.info(`[DD] c:"${this.getKey()}" detaches d:"${doc.getKey()}"`);
        resolve(doc);
      });
    });
  }

  /**
   * `sync` pushes local changes of the attached documents to the server and
   * receives changes of the remote replica from the server then apply them to
   * local documents.
   */
  public sync(): Promise<Array<Document<unknown>>> {
    const promises = [];
    for (const [, attachment] of this.attachmentMap) {
      promises.push(this.syncInternal(attachment.doc));
    }

    return Promise.all(promises)
      .then((docs) => {
        return docs;
      })
      .catch((err) => {
        this.eventStreamObserver.next({
          type: ClientEventType.DocumentSynced,
          value: DocumentSyncResultType.SyncFailed,
        });
        throw err;
      });
  }

  /**
   * `updatePresence` updates the presence of this client.
   */
  public updatePresence<K extends keyof P>(key: K, value: P[K]): Promise<void> {
    if (!this.isActive()) {
      throw new YorkieError(Code.ClientNotActive, `${this.key} is not active`);
    }

    this.presenceInfo.clock += 1;
    this.presenceInfo.data[key] = value;

    if (this.attachmentMap.size === 0) {
      return Promise.resolve();
    }

    const keys: Array<string> = [];
    for (const [, attachment] of this.attachmentMap) {
      if (!attachment.isRealtimeSync) {
        continue;
      }

      attachment.peerPresenceMap!.set(this.getID()!, this.presenceInfo);
      keys.push(attachment.doc.getKey());
    }

    const req = new UpdatePresenceRequest();
    req.setClient(converter.toClient(this.id!, this.presenceInfo));
    req.setDocumentKeysList(keys);

    if (this.eventStreamObserver) {
      this.eventStreamObserver.next({
        type: ClientEventType.PeersChanged,
        value: keys.reduce(this.getPeersWithDocKey, {}),
      });
    }

    return new Promise((resolve, reject) => {
      this.rpcClient.updatePresence(req, {}, (err) => {
        if (err) {
          logger.error(`[UM] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        logger.info(`[UM] c"${this.getKey()}" updated`);
        resolve();
      });
    });
  }

  /**
   * `subscribe` subscribes to the given topics.
   */
  public subscribe(
    nextOrObserver: Observer<ClientEvent<P>> | NextFn<ClientEvent<P>>,
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe {
    return this.eventStream.subscribe(
      nextOrObserver as NextFn<ClientEvent<P>>,
      error,
      complete,
    );
  }

  /**
   * `getID` returns a ActorID of client.
   */
  public getID(): string | undefined {
    return this.id;
  }

  /**
   * `getKey` returns a key of client.
   */
  public getKey(): string {
    return this.key;
  }

  /**
   * `isActive` checks if the client is active.
   */
  public isActive(): boolean {
    return this.status === ClientStatus.Activated;
  }

  /**
   * `getStatus` returns the status of this client.
   */
  public getStatus(): ClientStatus {
    return this.status;
  }

  /**
   * `getPresence` returns the presence of this client.
   */
  public getPresence(): P {
    return this.presenceInfo.data;
  }

  /**
   * `getPeers` returns the peers of the given document.
   */
  public getPeers(key: string): Record<string, P> {
    const peers: Record<string, P> = {};
    const attachment = this.attachmentMap.get(key);
    for (const [key, value] of attachment!.peerPresenceMap!) {
      peers[key] = value.data;
    }
    return peers;
  }

  /**
   * `getPeersWithDocKey` returns the peers of the given document wrapped in an object.
   */
  private getPeersWithDocKey = (
    peersMap: Record<string, Record<string, P>>,
    key: string,
  ): Record<string, Record<string, P>> => {
    const attachment = this.attachmentMap.get(key);
    const peers: Record<string, P> = {};
    for (const [key, value] of attachment!.peerPresenceMap!) {
      peers[key] = value.data;
    }
    peersMap[key] = peers;
    return peersMap;
  };

  private runSyncLoop(): void {
    const doLoop = (): void => {
      if (!this.isActive()) {
        logger.debug(`[SL] c:"${this.getKey()}" exit sync loop`);
        return;
      }

      const promises = [];
      for (const [, attachment] of this.attachmentMap) {
        if (
          attachment.isRealtimeSync &&
          (attachment.doc.hasLocalChanges() ||
            attachment.remoteChangeEventReceived)
        ) {
          attachment.remoteChangeEventReceived = false;
          promises.push(this.syncInternal(attachment.doc));
        }
      }

      Promise.all(promises)
        .then(() => {
          const syncLoopDuration = this.remoteChangeEventStream
            ? this.syncLoopDuration
            : this.reconnectStreamDelay;
          setTimeout(doLoop, syncLoopDuration);
        })
        .catch((err) => {
          logger.error(`[SL] c:"${this.getKey()}" sync failed:`, err);
          this.eventStreamObserver.next({
            type: ClientEventType.DocumentSynced,
            value: DocumentSyncResultType.SyncFailed,
          });
          setTimeout(doLoop, this.reconnectStreamDelay);
        });
    };

    logger.debug(`[SL] c:"${this.getKey()}" run sync loop`);
    doLoop();
  }

  private runWatchLoop(): void {
    const doLoop = (): void => {
      if (this.remoteChangeEventStream) {
        this.remoteChangeEventStream.cancel();
        this.remoteChangeEventStream = undefined;
      }

      if (this.watchLoopTimerID) {
        clearTimeout(this.watchLoopTimerID);
        this.watchLoopTimerID = undefined;
      }

      if (!this.isActive()) {
        logger.debug(`[WL] c:"${this.getKey()}" exit watch loop`);
        return;
      }

      const realtimeSyncDocKeys: Array<string> = [];
      for (const [, attachment] of this.attachmentMap) {
        if (attachment.isRealtimeSync) {
          realtimeSyncDocKeys.push(attachment.doc.getKey());
        }
      }

      if (!realtimeSyncDocKeys.length) {
        logger.debug(`[WL] c:"${this.getKey()}" exit watch loop`);
        return;
      }

      const req = new WatchDocumentsRequest();
      req.setClient(converter.toClient(this.id!, this.presenceInfo));
      req.setDocumentKeysList(realtimeSyncDocKeys);

      const onStreamDisconnect = () => {
        this.remoteChangeEventStream = undefined;
        this.watchLoopTimerID = setTimeout(doLoop, this.reconnectStreamDelay);
        this.eventStreamObserver.next({
          type: ClientEventType.StreamConnectionStatusChanged,
          value: StreamConnectionStatus.Disconnected,
        });
      };

      const stream = this.rpcClient.watchDocuments(req, {});
      stream.on('data', (resp: WatchDocumentsResponse) => {
        this.handleWatchDocumentsResponse(realtimeSyncDocKeys, resp);
      });
      stream.on('end', onStreamDisconnect);
      stream.on('error', onStreamDisconnect);
      this.remoteChangeEventStream = stream;

      logger.info(
        `[WD] c:"${this.getKey()}" watches d:"${realtimeSyncDocKeys.map(
          (key) => key,
        )}"`,
      );
    };

    logger.debug(`[WL] c:"${this.getKey()}" run watch loop`);

    doLoop();
  }

  private handleWatchDocumentsResponse(
    keys: Array<string>,
    resp: WatchDocumentsResponse,
  ) {
    if (resp.hasInitialization()) {
      const pbPeersMap = resp.getInitialization()!.getPeersMapByDocMap();
      pbPeersMap.forEach((pbPeers, docID) => {
        const attachment = this.attachmentMap.get(docID);
        for (const pbClient of pbPeers.getClientsList()) {
          attachment!.peerPresenceMap!.set(
            converter.toHexString(pbClient.getId_asU8()),
            converter.fromPresence(pbClient.getPresence()!),
          );
        }
      });

      this.eventStreamObserver.next({
        type: ClientEventType.PeersChanged,
        value: keys.reduce(this.getPeersWithDocKey, {}),
      });
      return;
    }

    const pbWatchEvent = resp.getEvent()!;
    const respKeys = pbWatchEvent.getDocumentKeysList();
    const publisher = converter.toHexString(
      pbWatchEvent.getPublisher()!.getId_asU8(),
    );
    const presence = converter.fromPresence<P>(
      pbWatchEvent.getPublisher()!.getPresence()!,
    );
    for (const key of respKeys) {
      const attachment = this.attachmentMap.get(key)!;
      const peerPresenceMap = attachment.peerPresenceMap!;
      switch (pbWatchEvent.getType()) {
        case DocEventType.DOC_EVENT_TYPE_DOCUMENTS_WATCHED:
          peerPresenceMap!.set(publisher, presence);
          break;
        case DocEventType.DOC_EVENT_TYPE_DOCUMENTS_UNWATCHED:
          peerPresenceMap!.delete(publisher);
          break;
        case DocEventType.DOC_EVENT_TYPE_DOCUMENTS_CHANGED:
          attachment.remoteChangeEventReceived = true;
          break;
        case DocEventType.DOC_EVENT_TYPE_PRESENCE_CHANGED:
          if (
            peerPresenceMap!.has(publisher) &&
            peerPresenceMap!.get(publisher)!.clock > presence.clock
          ) {
            break;
          }
          peerPresenceMap!.set(publisher, presence);
          break;
      }
    }

    if (
      pbWatchEvent!.getType() === DocEventType.DOC_EVENT_TYPE_DOCUMENTS_CHANGED
    ) {
      this.eventStreamObserver.next({
        type: ClientEventType.DocumentsChanged,
        value: respKeys,
      });
    } else if (
      pbWatchEvent!.getType() ===
        DocEventType.DOC_EVENT_TYPE_DOCUMENTS_WATCHED ||
      pbWatchEvent!.getType() ===
        DocEventType.DOC_EVENT_TYPE_DOCUMENTS_UNWATCHED ||
      pbWatchEvent!.getType() === DocEventType.DOC_EVENT_TYPE_PRESENCE_CHANGED
    ) {
      this.eventStreamObserver.next({
        type: ClientEventType.PeersChanged,
        value: respKeys.reduce(this.getPeersWithDocKey, {}),
      });
    }
  }

  private syncInternal(doc: Document<unknown>): Promise<Document<unknown>> {
    return new Promise((resolve, reject) => {
      const req = new PushPullRequest();
      req.setClientId(converter.toUint8Array(this.id!));
      const reqPack = doc.createChangePack();
      const localSize = reqPack.getChangeSize();
      req.setChangePack(converter.toChangePack(reqPack));

      let isRejected = false;
      this.rpcClient
        .pushPull(req, {}, (err, res) => {
          if (err) {
            logger.error(`[PP] c:"${this.getKey()}" err :`, err);

            isRejected = true;
            reject(err);
            return;
          }

          const respPack = converter.fromChangePack(res.getChangePack()!);
          doc.applyChangePack(respPack);
          this.eventStreamObserver.next({
            type: ClientEventType.DocumentSynced,
            value: DocumentSyncResultType.Synced,
          });

          const docKey = doc.getKey();
          const remoteSize = respPack.getChangeSize();
          logger.info(
            `[PP] c:"${this.getKey()}" sync d:"${docKey}", push:${localSize} pull:${remoteSize} cp:${respPack
              .getCheckpoint()
              .getStructureAsString()}`,
          );
        })
        .on('end', () => {
          if (isRejected) {
            return;
          }
          resolve(doc);
        });
    });
  }
}
