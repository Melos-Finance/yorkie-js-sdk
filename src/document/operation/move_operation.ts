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

import { logger } from '@yorkie-js-sdk/src/util/logger';
import { TimeTicket } from '@yorkie-js-sdk/src/document/time/ticket';
import { CRDTRoot } from '@yorkie-js-sdk/src/document/crdt/root';
import { CRDTArray } from '@yorkie-js-sdk/src/document/crdt/array';
import { Operation } from '@yorkie-js-sdk/src/document/operation/operation';

/**
 * `MoveOperation` is an operation representing moving an element to an Array.
 */
export class MoveOperation extends Operation {
  private prevCreatedAt: TimeTicket;
  private createdAt: TimeTicket;

  constructor(
    parentCreatedAt: TimeTicket,
    prevCreatedAt: TimeTicket,
    createdAt: TimeTicket,
    executedAt: TimeTicket,
  ) {
    super(parentCreatedAt, executedAt);
    this.prevCreatedAt = prevCreatedAt;
    this.createdAt = createdAt;
  }

  /**
   * `create` creates a new instance of MoveOperation.
   */
  public static create(
    parentCreatedAt: TimeTicket,
    prevCreatedAt: TimeTicket,
    createdAt: TimeTicket,
    executedAt: TimeTicket,
  ): MoveOperation {
    return new MoveOperation(
      parentCreatedAt,
      prevCreatedAt,
      createdAt,
      executedAt,
    );
  }

  /**
   * `execute` executes this operation on the given document(`root`).
   */
  public execute(root: CRDTRoot): void {
    const parentObject = root.findByCreatedAt(this.getParentCreatedAt());
    if (parentObject instanceof CRDTArray) {
      const array = parentObject as CRDTArray;
      array.moveAfter(
        this.prevCreatedAt!,
        this.createdAt,
        this.getExecutedAt(),
      );
    } else {
      if (!parentObject) {
        logger.fatal(`fail to find ${this.getParentCreatedAt()}`);
      }

      logger.fatal(`fail to execute, only array can execute add`);
    }
  }

  /**
   * `getEffectedCreatedAt` returns the time of the effected element.
   */
  public getEffectedCreatedAt(): TimeTicket {
    return this.createdAt;
  }

  /**
   * `getStructureAsString` returns a string containing the meta data.
   */
  public getStructureAsString(): string {
    return `${this.getParentCreatedAt().getStructureAsString()}.MOV`;
  }

  /**
   * `getPrevCreatedAt` returns the creation time of previous element.
   */
  public getPrevCreatedAt(): TimeTicket {
    return this.prevCreatedAt;
  }

  /**
   * `getCreatedAt` returns the creation time of the target element.
   */
  public getCreatedAt(): TimeTicket {
    return this.createdAt;
  }
}
