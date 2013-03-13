/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/PhoneNumberUtils.jsm");

const RIL_MOBILEMESSAGEDATABASESERVICE_CONTRACTID = "@mozilla.org/mobilemessage/rilmobilemessagedatabaseservice;1";
const RIL_MOBILEMESSAGEDATABASESERVICE_CID = Components.ID("{29785f90-6b5b-11e2-9201-3b280170b2ec}");

const DEBUG = false;
const DB_NAME = "sms";
const DB_VERSION = 7;
const MESSAGE_STORE_NAME = "sms";
const MOST_RECENT_STORE_NAME = "most-recent";

const DELIVERY_SENDING = "sending";
const DELIVERY_RECEIVED = "received";

const DELIVERY_STATUS_NOT_APPLICABLE = "not-applicable";
const DELIVERY_STATUS_SUCCESS = "success";
const DELIVERY_STATUS_PENDING = "pending";
const DELIVERY_STATUS_ERROR = "error";

const MESSAGE_CLASS_NORMAL = "normal";

const FILTER_TIMESTAMP = "timestamp";
const FILTER_NUMBERS = "numbers";
const FILTER_DELIVERY = "delivery";
const FILTER_READ = "read";

// We can´t create an IDBKeyCursor with a boolean, so we need to use numbers
// instead.
const FILTER_READ_UNREAD = 0;
const FILTER_READ_READ = 1;

const READ_ONLY = "readonly";
const READ_WRITE = "readwrite";
const PREV = "prev";
const NEXT = "next";

XPCOMUtils.defineLazyServiceGetter(this, "gSmsService",
                                   "@mozilla.org/sms/smsservice;1",
                                   "nsISmsService");

XPCOMUtils.defineLazyServiceGetter(this, "gIDBManager",
                                   "@mozilla.org/dom/indexeddb/manager;1",
                                   "nsIIndexedDatabaseManager");

const GLOBAL_SCOPE = this;

function getNumberFromRecord(aMessageRecord) {
  return aMessageRecord.delivery == DELIVERY_RECEIVED ? aMessageRecord.sender
                                                      : aMessageRecord.receiver;
}

/**
 * MobileMessageDatabaseService
 */
function MobileMessageDatabaseService() {
  // Prime the directory service's cache to ensure that the ProfD entry exists
  // by the time IndexedDB queries for it off the main thread. (See bug 743635.)
  Services.dirsvc.get("ProfD", Ci.nsIFile);

  gIDBManager.initWindowless(GLOBAL_SCOPE);

  let that = this;
  this.newTxn(READ_ONLY, function(error, txn, messageStore){
    if (error) {
      return;
    }
    // In order to get the highest key value, we open a key cursor in reverse
    // order and get only the first pointed value.
    let request = messageStore.openCursor(null, PREV);
    request.onsuccess = function onsuccess(event) {
      let cursor = event.target.result;
      if (!cursor) {
        if (DEBUG) {
          debug("Could not get the last key from mobile message database. " +
                "Probably empty database");
        }
        return;
      }
      that.lastMessageId = cursor.key || 0;
      if (DEBUG) debug("Last assigned message ID was " + that.lastMessageId);
    };
    request.onerror = function onerror(event) {
      if (DEBUG) {
        debug("Could not get the last key from mobile message database " +
              event.target.errorCode);
      }
    };
  });

  this.messageLists = {};
}
MobileMessageDatabaseService.prototype = {

  classID: RIL_MOBILEMESSAGEDATABASESERVICE_CID,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIRilMobileMessageDatabaseService,
                                         Ci.nsIMobileMessageDatabaseService,
                                         Ci.nsIObserver]),

  /**
   * Cache the DB here.
   */
  db: null,

  /**
   * This object keeps the message lists associated with each search. Each
   * message list is stored as an array of primary keys.
   */
  messageLists: null,

  lastMessageListId: 0,

  /**
   * Last sms object store key value in the database.
   */
  lastMessageId: 0,

  /**
   * nsIObserver
   */
  observe: function observe() {},

  /**
   * Prepare the database. This may include opening the database and upgrading
   * it to the latest schema version.
   *
   * @param callback
   *        Function that takes an error and db argument. It is called when
   *        the database is ready to use or if an error occurs while preparing
   *        the database.
   *
   * @return (via callback) a database ready for use.
   */
  ensureDB: function ensureDB(callback) {
    if (this.db) {
      if (DEBUG) debug("ensureDB: already have a database, returning early.");
      callback(null, this.db);
      return;
    }

    let self = this;
    function gotDB(db) {
      self.db = db;
      callback(null, db);
    }

    let request = GLOBAL_SCOPE.indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = function (event) {
      if (DEBUG) debug("Opened database:", DB_NAME, DB_VERSION);
      gotDB(event.target.result);
    };
    request.onupgradeneeded = function (event) {
      if (DEBUG) {
        debug("Database needs upgrade:", DB_NAME,
              event.oldVersion, event.newVersion);
        debug("Correct new database version:", event.newVersion == DB_VERSION);
      }

      let db = event.target.result;
      let currentVersion = event.oldVersion;
      while (currentVersion != event.newVersion) {
        switch (currentVersion) {
          case 0:
            if (DEBUG) debug("New database");
            self.createSchema(db);
            break;
          case 1:
            if (DEBUG) debug("Upgrade to version 2. Including `read` index");
            self.upgradeSchema(event.target.transaction);
            break;
          case 2:
            if (DEBUG) debug("Upgrade to version 3. Fix existing entries.");
            self.upgradeSchema2(event.target.transaction);
            break;
          case 3:
            if (DEBUG) debug("Upgrade to version 4. Add quick threads view.");
            self.upgradeSchema3(db, event.target.transaction);
            break;
          case 4:
            if (DEBUG) debug("Upgrade to version 5. Populate quick threads view.");
            self.upgradeSchema4(event.target.transaction);
            break;
          case 5:
            if (DEBUG) debug("Upgrade to version 6. Use PhonenumberJS.");
            self.upgradeSchema5(event.target.transaction);
            break;
          case 6:
            if (DEBUG) debug("Upgrade to version 7. Use multiple entry indexes.");
            self.upgradeSchema6(event.target.transaction);
            break;
          default:
            event.target.transaction.abort();
            callback("Old database version: " + event.oldVersion, null);
            break;
        }
        currentVersion++;
      }
    };
    request.onerror = function (event) {
      //TODO look at event.target.Code and change error constant accordingly
      callback("Error opening database!", null);
    };
    request.onblocked = function (event) {
      callback("Opening database request is blocked.", null);
    };
  },

  /**
   * Start a new transaction.
   *
   * @param txn_type
   *        Type of transaction (e.g. READ_WRITE)
   * @param callback
   *        Function to call when the transaction is available. It will
   *        be invoked with the transaction and opened object stores.
   * @param storeNames
   *        Names of the stores to open.
   */
  newTxn: function newTxn(txn_type, callback, storeNames) {
    if (!storeNames) {
      storeNames = [MESSAGE_STORE_NAME];
    }
    if (DEBUG) debug("Opening transaction for object stores: " + storeNames);
    this.ensureDB(function (error, db) {
      if (error) {
        if (DEBUG) debug("Could not open database: " + error);
        callback(error);
        return;
      }
      let txn = db.transaction(storeNames, txn_type);
      if (DEBUG) debug("Started transaction " + txn + " of type " + txn_type);
      if (DEBUG) {
        txn.oncomplete = function oncomplete(event) {
          debug("Transaction " + txn + " completed.");
        };
        txn.onerror = function onerror(event) {
          //TODO check event.target.errorCode and show an appropiate error
          //     message according to it.
          debug("Error occurred during transaction: " + event.target.errorCode);
        };
      }
      let stores;
      if (storeNames.length == 1) {
        if (DEBUG) debug("Retrieving object store " + storeNames[0]);
        stores = txn.objectStore(storeNames[0]);
      } else {
        stores = [];
        for each (let storeName in storeNames) {
          if (DEBUG) debug("Retrieving object store " + storeName);
          stores.push(txn.objectStore(storeName));
        }
      }
      callback(null, txn, stores);
    });
  },

  /**
   * Create the initial database schema.
   *
   * TODO need to worry about number normalization somewhere...
   * TODO full text search on body???
   */
  createSchema: function createSchema(db) {
    // This messageStore holds the main mobile message data.
    let messageStore = db.createObjectStore(MESSAGE_STORE_NAME, { keyPath: "id" });
    messageStore.createIndex("timestamp", "timestamp", { unique: false });
    if (DEBUG) debug("Created object stores and indexes");
  },

  /**
   * Upgrade to the corresponding database schema version.
   */
  upgradeSchema: function upgradeSchema(transaction) {
    let messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
    messageStore.createIndex("read", "read", { unique: false });
  },

  upgradeSchema2: function upgradeSchema2(transaction) {
    let messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
    messageStore.openCursor().onsuccess = function(event) {
      let cursor = event.target.result;
      if (!cursor) {
        return;
      }

      let messageRecord = cursor.value;
      messageRecord.messageClass = MESSAGE_CLASS_NORMAL;
      messageRecord.deliveryStatus = DELIVERY_STATUS_NOT_APPLICABLE;
      cursor.update(messageRecord);
      cursor.continue();
    };
  },

  upgradeSchema3: function upgradeSchema3(db, transaction) {
    // Delete redundant "id" index.
    let messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
    if (messageStore.indexNames.contains("id")) {
      messageStore.deleteIndex("id");
    }

    /**
     * This mostRecentStore can be used to quickly construct a thread view of
     * the mobile message database. Each entry looks like this:
     *
     * { senderOrReceiver: <String> (primary key),
     *   id: <Number>,
     *   timestamp: <Date>,
     *   body: <String>,
     *   unreadCount: <Number> }
     *
     */
    let mostRecentStore = db.createObjectStore(MOST_RECENT_STORE_NAME,
                                               { keyPath: "senderOrReceiver" });
    mostRecentStore.createIndex("timestamp", "timestamp");
  },

  upgradeSchema4: function upgradeSchema4(transaction) {
    let threads = {};
    let messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
    let mostRecentStore = transaction.objectStore(MOST_RECENT_STORE_NAME);

    messageStore.openCursor().onsuccess = function(event) {
      let cursor = event.target.result;
      if (!cursor) {
        for (let thread in threads) {
          mostRecentStore.put(threads[thread]);
        }
        return;
      }

      let messageRecord = cursor.value;
      let contact = messageRecord.sender || messageRecord.receiver;

      if (contact in threads) {
        let thread = threads[contact];
        if (!messageRecord.read) {
          thread.unreadCount++;
        }
        if (messageRecord.timestamp > thread.timestamp) {
          thread.id = messageRecord.id;
          thread.body = messageRecord.body;
          thread.timestamp = messageRecord.timestamp;
        }
      } else {
        threads[contact] = {
          senderOrReceiver: contact,
          id: messageRecord.id,
          timestamp: messageRecord.timestamp,
          body: messageRecord.body,
          unreadCount: messageRecord.read ? 0 : 1
        };
      }
      cursor.continue();
    };
  },

  upgradeSchema5: function upgradeSchema5(transaction) {
    // Don't perform any upgrade. See Bug 819560.
  },

  upgradeSchema6: function upgradeSchema6(transaction) {
    let messageStore = transaction.objectStore(MESSAGE_STORE_NAME);

    // Delete "delivery" index.
    if (messageStore.indexNames.contains("delivery")) {
      messageStore.deleteIndex("delivery");
    }
    // Delete "sender" index.
    if (messageStore.indexNames.contains("sender")) {
      messageStore.deleteIndex("sender");
    }
    // Delete "receiver" index.
    if (messageStore.indexNames.contains("receiver")) {
      messageStore.deleteIndex("receiver");
    }
    // Delete "read" index.
    if (messageStore.indexNames.contains("read")) {
      messageStore.deleteIndex("read");
    }

    // Create new "delivery", "number" and "read" indexes.
    messageStore.createIndex("delivery", "deliveryIndex");
    messageStore.createIndex("number", "numberIndex", { multiEntry: true });
    messageStore.createIndex("read", "readIndex");

    // Populate new "deliverIndex", "numberIndex" and "readIndex" attributes.
    messageStore.openCursor().onsuccess = function(event) {
      let cursor = event.target.result;
      if (!cursor) {
        return;
      }

      let messageRecord = cursor.value;
      let timestamp = messageRecord.timestamp;
      messageRecord.deliveryIndex = [messageRecord.delivery, timestamp];
      messageRecord.numberIndex = [
        [messageRecord.sender, timestamp],
        [messageRecord.receiver, timestamp]
      ];
      messageRecord.readIndex = [messageRecord.read, timestamp];
      cursor.update(messageRecord);
      cursor.continue();
    };
  },

  createSmsMessageFromRecord: function createSmsMessageFromRecord(aMessageRecord) {
    if (DEBUG) {
      debug("createSmsMessageFromRecord: " + JSON.stringify(aMessageRecord));
    }
    return gSmsService.createSmsMessage(aMessageRecord.id,
                                        aMessageRecord.delivery,
                                        aMessageRecord.deliveryStatus,
                                        aMessageRecord.sender,
                                        aMessageRecord.receiver,
                                        aMessageRecord.body,
                                        aMessageRecord.messageClass,
                                        aMessageRecord.timestamp,
                                        aMessageRecord.read);
  },

  /**
   * Queue up passed message id, reply if necessary. 'aMessageId' = 0 for no
   * more messages, negtive for errors and valid otherwise.
   */
  onNextMessageInListGot: function onNextMessageInListGot(
      aMessageStore, aMessageList, aMessageId) {

    if (DEBUG) {
      debug("onNextMessageInListGot - listId: "
            + aMessageList.listId + ", messageId: " + aMessageId);
    }
    if (aMessageId) {
      // Queue up any id but '0' and replies later accordingly.
      aMessageList.results.push(aMessageId);
    }
    if (aMessageId <= 0) {
      // No more processing on '0' or negative values passed.
      aMessageList.processing = false;
    }

    if (!aMessageList.requestWaiting) {
      if (DEBUG) debug("Cursor.continue() not called yet");
      return;
    }

    // We assume there is only one request waiting throughout the message list
    // retrieving process. So we don't bother continuing to process further
    // waiting requests here. This assumption comes from SmsCursor::Continue()
    // implementation.
    let smsRequest = aMessageList.requestWaiting;
    aMessageList.requestWaiting = null;

    if (!aMessageList.results.length) {
      // No fetched results yet.
      if (!aMessageList.processing) {
        if (DEBUG) debug("No messages matching the filter criteria");
        smsRequest.notifyNoMessageInList();
      }
      // No fetched results yet and still processing. Let's wait a bit more.
      return;
    }

    if (aMessageList.results[0] < 0) {
      // An previous error found. Keep the answer in results so that we can
      // reply INTERNAL_ERROR for further requests.
      if (DEBUG) debug("An previous error found");
      smsRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      return;
    }

    let firstMessageId = aMessageList.results.shift();
    if (DEBUG) debug ("Fetching message " + firstMessageId);

    let getRequest = aMessageStore.get(firstMessageId);
    let self = this;
    getRequest.onsuccess = function onsuccess(event) {
      let sms = self.createSmsMessageFromRecord(event.target.result);
      if (aMessageList.listId >= 0) {
        if (DEBUG) {
          debug("notifyNextMessageInListGot - listId: "
                + aMessageList.listId + ", messageId: " + firstMessageId);
        }
        smsRequest.notifyNextMessageInListGot(sms);
      } else {
        self.lastMessageListId += 1;
        aMessageList.listId = self.lastMessageListId;
        self.messageLists[self.lastMessageListId] = aMessageList;
        if (DEBUG) {
          debug("notifyMessageListCreated - listId: "
                + aMessageList.listId + ", messageId: " + firstMessageId);
        }
        smsRequest.notifyMessageListCreated(aMessageList.listId, sms);
      }
    };
    getRequest.onerror = function onerror(event) {
      if (DEBUG) {
        debug("notifyReadMessageListFailed - listId: "
              + aMessageList.listId + ", messageId: " + firstMessageId);
      }
      smsRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
    };
  },

  /**
   * Queue up {aMessageId, aTimestamp} pairs, find out intersections and report
   * to onNextMessageInListGot. Return true if it is still possible to have
   * another match.
   */
  onNextMessageInMultiFiltersGot: function onNextMessageInMultiFiltersGot(
      aMessageStore, aMessageList, aContextIndex, aMessageId, aTimestamp) {

    if (DEBUG) {
      debug("onNextMessageInMultiFiltersGot: "
            + aContextIndex + ", " + aMessageId + ", " + aTimestamp);
    }
    let contexts = aMessageList.contexts;

    if (!aMessageId) {
      contexts[aContextIndex].processing = false;
      for (let i = 0; i < contexts.length; i++) {
        if (contexts[i].processing) {
          return false;
        }
      }

      this.onNextMessageInListGot(aMessageStore, aMessageList, 0);
      return false;
    }

    // Search id in other existing results. If no other results has it,
    // and A) the last timestamp is smaller-equal to current timestamp,
    // we wait for further results; either B) record timestamp is larger
    // then current timestamp or C) no more processing for a filter, then we
    // drop this id because there can't be a match anymore.
    for (let i = 0; i < contexts.length; i++) {
      if (i == aContextIndex) {
        continue;
      }

      let ctx = contexts[i];
      let results = ctx.results;
      let found = false;
      for (let j = 0; j < results.length; j++) {
        let result = results[j];
        if (result.id == aMessageId) {
          found = true;
          break;
        }
        if ((!aMessageList.reverse && (result.timestamp > aTimestamp)) ||
            (aMessageList.reverse && (result.timestamp < aTimestamp))) {
          // B) Cannot find a match anymore. Drop.
          return true;
        }
      }

      if (!found) {
        if (!ctx.processing) {
          // C) Cannot find a match anymore. Drop.
          if (results.length) {
            let lastResult = results[results.length - 1];
            if ((!aMessageList.reverse && (lastResult.timestamp >= aTimestamp)) ||
                (aMessageList.reverse && (lastResult.timestamp <= aTimestamp))) {
              // Still have a chance to get another match. Return true.
              return true;
            }
          }

          // Impossible to find another match because all results in ctx have
          // timestamps smaller than aTimestamp.
          return this.onNextMessageInMultiFiltersGot(aMessageStore, aMessageList,
                                                     aContextIndex, 0, 0);
        }

        // A) Pending.
        contexts[aContextIndex].results.push({
          id: aMessageId,
          timestamp: aTimestamp
        });
        return true;
      }
    }

    // Now id is found in all other results. Report it.
    this.onNextMessageInListGot(aMessageStore, aMessageList, aMessageId);
    return true;
  },

  onNextMessageInMultiNumbersGot: function onNextMessageInMultiNumbersGot(
      aMessageStore, aMessageList, aContextIndex,
      aQueueIndex, aMessageId, aTimestamp) {

    if (DEBUG) {
      debug("onNextMessageInMultiNumbersGot: "
            + aQueueIndex + ", " + aMessageId + ", " + aTimestamp);
    }
    let queues = aMessageList.numberQueues;
    let q = queues[aQueueIndex];
    if (aMessageId) {
      if (!aQueueIndex) {
        // Timestamp.
        q.results.push({
          id: aMessageId,
          timestamp: aTimestamp
        });
      } else {
        // Numbers.
        q.results.push(aMessageId);
      }
      return true;
    }

    q.processing -= 1;
    if (queues[0].processing || queues[1].processing) {
      // At least one queue is still processing, but we got here because
      // current cursor gives 0 as aMessageId meaning no more messages are
      // available. Return false here to stop further cursor.continue() calls.
      return false;
    }

    let tres = queues[0].results;
    let qres = queues[1].results;
    tres = tres.filter(function (element) {
      return qres.indexOf(element.id) != -1;
    });
    if (aContextIndex < 0) {
      for (let i = 0; i < tres.length; i++) {
        this.onNextMessageInListGot(aMessageStore, aMessageList, tres[i].id);
      }
      this.onNextMessageInListGot(aMessageStore, aMessageList, 0);
    } else {
      for (let i = 0; i < tres.length; i++) {
        this.onNextMessageInMultiFiltersGot(aMessageStore, aMessageList,
                                            aContextIndex,
                                            tres[i].id, tres[i].timestamp);
      }
      this.onNextMessageInMultiFiltersGot(aMessageStore, aMessageList,
                                          aContextIndex, 0, 0);
    }
    return false;
  },

  saveRecord: function saveRecord(aMessageRecord, aCallback) {
    this.lastMessageId += 1;
    aMessageRecord.id = this.lastMessageId;
    if (DEBUG) debug("Going to store " + JSON.stringify(aMessageRecord));

    let self = this;
    function notifyResult(rv) {
      if (!aCallback) {
        return;
      }
      aCallback.notify(rv, aMessageRecord);
    }

    this.newTxn(READ_WRITE, function(error, txn, stores) {
      if (error) {
        // TODO bug 832140 check event.target.errorCode
        notifyResult(Cr.NS_ERROR_FAILURE);
        return;
      }
      txn.oncomplete = function oncomplete(event) {
        notifyResult(Cr.NS_OK);
      };
      txn.onabort = function onabort(event) {
        // TODO bug 832140 check event.target.errorCode
        notifyResult(Cr.NS_ERROR_FAILURE);
      };

      let messageStore = stores[0];
      let mostRecentStore = stores[1];

      // First add to message store.
      messageStore.put(aMessageRecord);

      // Next update most recent store.
      let number = getNumberFromRecord(aMessageRecord);
      mostRecentStore.get(number).onsuccess = function onsuccess(event) {
        let mostRecentRecord = event.target.result;
        if (mostRecentRecord) {
          let needsUpdate = false;

          if (mostRecentRecord.timestamp <= aMessageRecord.timestamp) {
            mostRecentRecord.timestamp = aMessageRecord.timestamp;
            mostRecentRecord.body = aMessageRecord.body;
            needsUpdate = true;
          }

          if (!aMessageRecord.read) {
            mostRecentRecord.unreadCount++;
            needsUpdate = true;
          }

          if (needsUpdate) {
            mostRecentStore.put(mostRecentRecord);
          }
        } else {
          mostRecentStore.add({
            senderOrReceiver: number,
            timestamp: aMessageRecord.timestamp,
            body: aMessageRecord.body,
            id: aMessageRecord.id,
            unreadCount: aMessageRecord.read ? 0 : 1
          });
        }
      };
    }, [MESSAGE_STORE_NAME, MOST_RECENT_STORE_NAME]);
    // We return the key that we expect to store in the db
    return aMessageRecord.id;
  },

  getRilIccInfoMsisdn: function getRilIccInfoMsisdn() {
    let iccInfo = this.mRIL.rilContext.icc;
    let number = iccInfo ? iccInfo.msisdn : null;

    // Workaround an xpconnect issue with undefined string objects.
    // See bug 808220
    if (number === undefined || number === "undefined") {
      return null;
    }
    return number;
  },

  makePhoneNumberInternational: function makePhoneNumberInternational(aNumber) {
    if (!aNumber) {
      return aNumber;
    }
    let parsedNumber = PhoneNumberUtils.parse(aNumber.toString());
    if (!parsedNumber || !parsedNumber.internationalNumber) {
      return aNumber;
    }
    return parsedNumber.internationalNumber;
  },

  /**
   * nsIRilMobileMessageDatabaseService API
   */

  saveReceivedMessage: function saveReceivedMessage(aMessage, aCallback) {
    if (aMessage.type === undefined ||
        aMessage.sender === undefined ||
        aMessage.messageClass === undefined ||
        aMessage.timestamp === undefined) {
      if (aCallback) {
        aCallback.notify(Cr.NS_ERROR_FAILURE, null);
      }
      return;
    }

    let receiver = this.getRilIccInfoMsisdn();
    receiver = this.makePhoneNumberInternational(receiver);

    let sender = aMessage.sender =
      this.makePhoneNumberInternational(aMessage.sender);

    let timestamp = aMessage.timestamp;

    // Adding needed indexes and extra attributes for internal use.
    aMessage.deliveryIndex = [DELIVERY_RECEIVED, timestamp];
    aMessage.numberIndex = [[sender, timestamp], [receiver, timestamp]];
    aMessage.readIndex = [FILTER_READ_UNREAD, timestamp];
    aMessage.delivery = DELIVERY_RECEIVED;
    aMessage.deliveryStatus = DELIVERY_STATUS_SUCCESS;
    aMessage.receiver = receiver;
    aMessage.read = FILTER_READ_UNREAD;

    return this.saveRecord(aMessage, aCallback);
  },

  saveSendingMessage: function saveSendingMessage(aMessage, aCallback) {
    if (aMessage.type === undefined ||
        aMessage.receiver === undefined ||
        aMessage.deliveryStatus === undefined ||
        aMessage.timestamp === undefined) {
      if (aCallback) {
        aCallback.notify(Cr.NS_ERROR_FAILURE, null);
      }
      return;
    }

    let sender = this.getRilIccInfoMsisdn();
    let receiver = aMessage.receiver;

    let rilContext = this.mRIL.rilContext;
    if (rilContext.voice.network.mcc === rilContext.icc.mcc) {
      receiver = aMessage.receiver = this.makePhoneNumberInternational(receiver);
      sender = this.makePhoneNumberInternational(sender);
    }

    let timestamp = aMessage.timestamp;

    // Adding needed indexes and extra attributes for internal use.
    aMessage.deliveryIndex = [DELIVERY_SENDING, timestamp];
    aMessage.numberIndex = [[sender, timestamp], [receiver, timestamp]];
    aMessage.readIndex = [FILTER_READ_READ, timestamp];
    aMessage.delivery = DELIVERY_SENDING;
    aMessage.sender = sender;
    aMessage.messageClass = MESSAGE_CLASS_NORMAL;
    aMessage.read = FILTER_READ_READ;

    return this.saveRecord(aMessage, aCallback);
  },

  setMessageDelivery: function setMessageDelivery(
      messageId, delivery, deliveryStatus, callback) {
    if (DEBUG) {
      debug("Setting message " + messageId + " delivery to " + delivery
            + ", and deliveryStatus to " + deliveryStatus);
    }

    let self = this;
    let messageRecord;
    function notifyResult(rv) {
      if (!callback) {
        return;
      }
      callback.notify(rv, messageRecord);
    }

    this.newTxn(READ_WRITE, function (error, txn, messageStore) {
      if (error) {
        // TODO bug 832140 check event.target.errorCode
        notifyResult(Cr.NS_ERROR_FAILURE);
        return;
      }
      txn.oncomplete = function oncomplete(event) {
        notifyResult(Cr.NS_OK);
      };
      txn.onabort = function onabort(event) {
        // TODO bug 832140 check event.target.errorCode
        notifyResult(Cr.NS_ERROR_FAILURE);
      };

      let getRequest = messageStore.get(messageId);
      getRequest.onsuccess = function onsuccess(event) {
        messageRecord = event.target.result;
        if (!messageRecord) {
          if (DEBUG) debug("Message ID " + messageId + " not found");
          return;
        }
        if (messageRecord.id != messageId) {
          if (DEBUG) {
            debug("Retrieve message ID (" + messageId + ") is " +
                  "different from the one we got");
          }
          return;
        }
        // Only updates messages that have different delivery or deliveryStatus.
        if ((messageRecord.delivery == delivery)
            && (messageRecord.deliveryStatus == deliveryStatus)) {
          if (DEBUG) {
            debug("The values of attribute delivery and deliveryStatus are the"
                  + " the same with given parameters.");
          }
          return;
        }
        messageRecord.delivery = delivery;
        messageRecord.deliveryIndex = [delivery, messageRecord.timestamp];
        messageRecord.deliveryStatus = deliveryStatus;
        if (DEBUG) {
          debug("Message.delivery set to: " + delivery
                + ", and Message.deliveryStatus set to: " + deliveryStatus);
        }
        messageStore.put(messageRecord);
      };
    });
  },

  /**
   * nsIMobileMessageDatabaseService API
   */

  getMessage: function getMessage(messageId, aRequest) {
    if (DEBUG) debug("Retrieving message with ID " + messageId);
    let self = this;
    this.newTxn(READ_ONLY, function (error, txn, messageStore) {
      if (error) {
        if (DEBUG) debug(error);
        aRequest.notifyGetMessageFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
        return;
      }
      let request = messageStore.mozGetAll(messageId);

      txn.oncomplete = function oncomplete() {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        if (request.result.length > 1) {
          if (DEBUG) debug("Got too many results for id " + messageId);
          aRequest.notifyGetMessageFailed(Ci.nsISmsRequest.UNKNOWN_ERROR);
          return;
        }
        let messageRecord = request.result[0];
        if (!messageRecord) {
          if (DEBUG) debug("Message ID " + messageId + " not found");
          aRequest.notifyGetMessageFailed(Ci.nsISmsRequest.NOT_FOUND_ERROR);
          return;
        }
        if (messageRecord.id != messageId) {
          if (DEBUG) {
            debug("Requested message ID (" + messageId + ") is " +
                  "different from the one we got");
          }
          aRequest.notifyGetMessageFailed(Ci.nsISmsRequest.UNKNOWN_ERROR);
          return;
        }
        let sms = self.createSmsMessageFromRecord(messageRecord);
        aRequest.notifyMessageGot(sms);
      };

      txn.onerror = function onerror(event) {
        if (DEBUG) {
          if (event.target)
            debug("Caught error on transaction", event.target.errorCode);
        }
        //TODO look at event.target.errorCode, pick appropriate error constant
        aRequest.notifyGetMessageFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      };
    });
  },

  deleteMessage: function deleteMessage(messageId, aRequest) {
    let deleted = false;
    let self = this;
    this.newTxn(READ_WRITE, function (error, txn, stores) {
      if (error) {
        aRequest.notifyDeleteMessageFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
        return;
      }
      txn.onerror = function onerror(event) {
        if (DEBUG) debug("Caught error on transaction", event.target.errorCode);
        //TODO look at event.target.errorCode, pick appropriate error constant
        aRequest.notifyDeleteMessageFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      };

      const messageStore = stores[0];
      const mostRecentStore = stores[1];

      let deleted = false;

      txn.oncomplete = function oncomplete(event) {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        aRequest.notifyMessageDeleted(deleted);
      };

      messageStore.get(messageId).onsuccess = function(event) {
        let messageRecord = event.target.result;
        if (messageRecord) {
          if (DEBUG) debug("Deleting message id " + messageId);

          // First actually delete the message.
          messageStore.delete(messageId).onsuccess = function(event) {
            deleted = true;

            // Then update unread count and most recent message.
            let number = getNumberFromRecord(messageRecord);

            mostRecentStore.get(number).onsuccess = function(event) {
              // This must exist.
              let mostRecentRecord = event.target.result;

              if (!messageRecord.read) {
                mostRecentRecord.unreadCount--;
              }

              if (mostRecentRecord.id == messageId) {
                // Check most recent sender/receiver.
                let numberRange = IDBKeyRange.bound([number, 0], [number, ""]);
                let numberRequest = messageStore.index("number")
                                                .openCursor(numberRange, PREV);
                numberRequest.onsuccess = function(event) {
                  let cursor = event.target.result;
                  if (!cursor) {
                    if (DEBUG) {
                      debug("Deleting mru entry for number '" + number + "'");
                    }
                    mostRecentStore.delete(number);
                    return;
                  }

                  let nextMsg = cursor.value;
                  mostRecentRecord.id = nextMsg.id;
                  mostRecentRecord.timestamp = nextMsg.timestamp;
                  mostRecentRecord.body = nextMsg.body;
                  if (DEBUG) {
                    debug("Updating mru entry: " +
                          JSON.stringify(mostRecentRecord));
                  }
                  mostRecentStore.put(mostRecentRecord);
                };
              } else if (!messageRecord.read) {
                // Shortcut, just update the unread count.
                if (DEBUG) {
                  debug("Updating unread count for number '" + number + "': " +
                        (mostRecentRecord.unreadCount + 1) + " -> " +
                        mostRecentRecord.unreadCount);
                }
                mostRecentStore.put(mostRecentRecord);
              }
            };
          };
        } else if (DEBUG) {
          debug("Message id " + messageId + " does not exist");
        }
      };
    }, [MESSAGE_STORE_NAME, MOST_RECENT_STORE_NAME]);
  },

  createMessageList: function createMessageList(filter, reverse, aRequest) {
    if (DEBUG) {
      debug("Creating a message list. Filters:" +
            " startDate: " + filter.startDate +
            " endDate: " + filter.endDate +
            " delivery: " + filter.delivery +
            " numbers: " + filter.numbers +
            " read: " + filter.read +
            " reverse: " + reverse);
    }

    let self = this;
    this.newTxn(READ_ONLY, function (error, txn, messageStore) {
      if (error) {
        //TODO look at event.target.errorCode, pick appropriate error constant.
        if (DEBUG) debug("IDBRequest error " + error.target.errorCode);
        aRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
        return;
      }

      let messageList = {
        listId: -1,
        reverse: reverse,
        processing: true,
        stop: false,
        // Local contexts for multiple filter targets' case.
        contexts: null,
        // Result queues for multiple numbers filter's case.
        numberQueues: null,
        // Pending createMessageList or getNextMessageInList SmsRequest.
        requestWaiting: aRequest,
        results: []
      };

      let onNextMessageInListGotCb =
        self.onNextMessageInListGot.bind(self, messageStore, messageList);

      let singleFilterSuccessCb = function onsfsuccess(event) {
        if (messageList.stop) {
          return;
        }

        let cursor = event.target.result;
        // Once the cursor has retrieved all keys that matches its key range,
        // the filter search is done.
        if (cursor) {
          onNextMessageInListGotCb(cursor.primaryKey);
          cursor.continue();
        } else {
          onNextMessageInListGotCb(0);
        }
      };

      let singleFilterErrorCb = function onsferror(event) {
        if (messageList.stop) {
          return;
        }

        if (DEBUG) debug("IDBRequest error " + event.target.errorCode);
        onNextMessageInListGotCb(-1);
      };

      let direction = reverse ? PREV : NEXT;

      // We support filtering by date range only (see `else` block below) or
      // by number/delivery status/read status with an optional date range.
      if (filter.delivery || filter.numbers || filter.read != undefined) {
        let multiFiltersGotCb = self.onNextMessageInMultiFiltersGot
                                    .bind(self, messageStore, messageList);

        let multiFiltersSuccessCb = function onmfsuccess(contextIndex, event) {
          if (messageList.stop) {
            return;
          }

          let cursor = event.target.result;
          if (cursor) {
            if (multiFiltersGotCb(contextIndex,
                                  cursor.primaryKey, cursor.key[1])) {
              cursor.continue();
            }
          } else {
            multiFiltersGotCb(contextIndex, 0, 0);
          }
        };

        let multiFiltersErrorCb = function onmferror(contextIndex, event) {
          if (messageList.stop) {
            return;
          }

          // Act as no more matched records.
          multiFiltersGotCb(contextIndex, 0, 0);
        };

        // Numeric 0 is smaller than any time stamp, and empty string is larger
        // than all numeric values.
        let startDate = 0, endDate = "";
        if (filter.startDate != null) {
          startDate = filter.startDate.getTime();
        }
        if (filter.endDate != null) {
          endDate = filter.endDate.getTime();
        }

        let singleFilter;
        {
          let numberOfContexts = 0;
          if (filter.delivery) numberOfContexts++;
          if (filter.numbers) numberOfContexts++;
          if (filter.read != undefined) numberOfContexts++;
          singleFilter = numberOfContexts == 1;
        }

        if (!singleFilter) {
          messageList.contexts = [];
        }

        let numberOfContexts = 0;

        let createRangedRequest = function crr(indexName, key) {
          let range = IDBKeyRange.bound([key, startDate], [key, endDate]);
          return messageStore.index(indexName).openKeyCursor(range, direction);
        };

        let createSimpleRangedRequest = function csrr(indexName, key) {
          let request = createRangedRequest(indexName, key);
          if (singleFilter) {
            request.onsuccess = singleFilterSuccessCb;
            request.onerror = singleFilterErrorCb;
          } else {
            let contextIndex = numberOfContexts++;
            messageList.contexts.push({
              processing: true,
              results: []
            });
            request.onsuccess = multiFiltersSuccessCb.bind(null, contextIndex);
            request.onerror = multiFiltersErrorCb.bind(null, contextIndex);
          }
        };

        // Retrieve the keys from the 'delivery' index that matches the
        // value of filter.delivery.
        if (filter.delivery) {
          if (DEBUG) debug("filter.delivery " + filter.delivery);
          createSimpleRangedRequest("delivery", filter.delivery);
        }

        // Retrieve the keys from the 'sender' and 'receiver' indexes that
        // match the values of filter.numbers
        if (filter.numbers) {
          if (DEBUG) debug("filter.numbers " + filter.numbers.join(", "));
          let multiNumbers = filter.numbers.length > 1;
          if (!multiNumbers) {
            createSimpleRangedRequest("number", filter.numbers[0]);
          } else {
            let contextIndex = -1;
            if (!singleFilter) {
              contextIndex = numberOfContexts++;
              messageList.contexts.push({
                processing: true,
                results: []
              });
            }

            let multiNumbersGotCb =
              self.onNextMessageInMultiNumbersGot
                  .bind(self, messageStore, messageList, contextIndex);

            let multiNumbersSuccessCb = function onmnsuccess(queueIndex, event) {
              if (messageList.stop) {
                return;
              }

              let cursor = event.target.result;
              if (cursor) {
                // If queueIndex is non-zero, it's timestamp result queue;
                // otherwise, it's per phone number result queue.
                let key = queueIndex ? cursor.key[1] : cursor.key;
                if (multiNumbersGotCb(queueIndex, cursor.primaryKey, key)) {
                  cursor.continue();
                }
              } else {
                multiNumbersGotCb(queueIndex, 0, 0);
              }
            };

            let multiNumbersErrorCb = function onmnerror(queueIndex, event) {
              if (messageList.stop) {
                return;
              }

              // Act as no more matched records.
              multiNumbersGotCb(queueIndex, 0, 0);
            };

            messageList.numberQueues = [{
              // For timestamp.
              processing: 1,
              results: []
            }, {
              // For all numbers.
              processing: filter.numbers.length,
              results: []
            }];

            let timeRange = null;
            if (filter.startDate != null && filter.endDate != null) {
              timeRange = IDBKeyRange.bound(filter.startDate.getTime(),
                                            filter.endDate.getTime());
            } else if (filter.startDate != null) {
              timeRange = IDBKeyRange.lowerBound(filter.startDate.getTime());
            } else if (filter.endDate != null) {
              timeRange = IDBKeyRange.upperBound(filter.endDate.getTime());
            }

            let timeRequest = messageStore.index("timestamp")
                                          .openKeyCursor(timeRange, direction);
            timeRequest.onsuccess = multiNumbersSuccessCb.bind(null, 0);
            timeRequest.onerror = multiNumbersErrorCb.bind(null, 0);

            for (let i = 0; i < filter.numbers.length; i++) {
              let request = createRangedRequest("number", filter.numbers[i]);
              request.onsuccess = multiNumbersSuccessCb.bind(null, 1);
              request.onerror = multiNumbersErrorCb.bind(null, 1);
            }
          }
        }

        // Retrieve the keys from the 'read' index that matches the value of
        // filter.read
        if (filter.read != undefined) {
          let read = filter.read ? FILTER_READ_READ : FILTER_READ_UNREAD;
          if (DEBUG) debug("filter.read " + read);
          createSimpleRangedRequest("read", read);
        }
      } else {
        // Filtering by date range only.
        if (DEBUG) {
          debug("filter.timestamp " + filter.startDate + ", " + filter.endDate);
        }

        let range = null;
        if (filter.startDate != null && filter.endDate != null) {
          range = IDBKeyRange.bound(filter.startDate.getTime(),
                                    filter.endDate.getTime());
        } else if (filter.startDate != null) {
          range = IDBKeyRange.lowerBound(filter.startDate.getTime());
        } else if (filter.endDate != null) {
          range = IDBKeyRange.upperBound(filter.endDate.getTime());
        }

        let request = messageStore.index("timestamp").openKeyCursor(range, direction);
        request.onsuccess = singleFilterSuccessCb;
        request.onerror = singleFilterErrorCb;
      }

      if (DEBUG) {
        txn.oncomplete = function oncomplete(event) {
          debug("Transaction " + txn + " completed.");
        };
      }

      txn.onerror = singleFilterErrorCb;
    });
  },

  getNextMessageInList: function getNextMessageInList(listId, aRequest) {
    if (DEBUG) debug("Getting next message in list " + listId);
    let messageId;
    let list = this.messageLists[listId];
    if (!list) {
      if (DEBUG) debug("Wrong list id");
      aRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.NOT_FOUND_ERROR);
      return;
    }
    if (list.processing) {
      // Database transaction ongoing, let it reply for us so that we won't get
      // blocked by the existing transaction.
      if (list.requestWaiting) {
        if (DEBUG) debug("Already waiting for another request!");
        return;
      }
      list.requestWaiting = aRequest;
      return;
    }
    if (!list.results.length) {
      if (DEBUG) debug("Reached the end of the list!");
      aRequest.notifyNoMessageInList();
      return;
    }
    if (list.results[0] < 0) {
      aRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      return;
    }
    messageId = list.results.shift();
    let self = this;
    this.newTxn(READ_ONLY, function (error, txn, messageStore) {
      if (DEBUG) debug("Fetching message " + messageId);
      let request = messageStore.get(messageId);
      let messageRecord;
      request.onsuccess = function onsuccess(event) {
        messageRecord = request.result;
      };

      txn.oncomplete = function oncomplete(event) {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        if (!messageRecord) {
          if (DEBUG) debug("Could not get message id " + messageId);
          aRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.NOT_FOUND_ERROR);
        }
        let sms = self.createSmsMessageFromRecord(messageRecord);
        aRequest.notifyNextMessageInListGot(sms);
      };

      txn.onerror = function onerror(event) {
        //TODO check event.target.errorCode
        if (DEBUG) {
          debug("Error retrieving message id: " + messageId +
                ". Error code: " + event.target.errorCode);
        }
        aRequest.notifyReadMessageListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      };
    });
  },

  clearMessageList: function clearMessageList(listId) {
    if (DEBUG) debug("Clearing message list: " + listId);
    if (this.messageLists[listId]) {
      this.messageLists[listId].stop = true;
      delete this.messageLists[listId];
    }
  },

  markMessageRead: function markMessageRead(messageId, value, aRequest) {
    if (DEBUG) debug("Setting message " + messageId + " read to " + value);
    this.newTxn(READ_WRITE, function (error, txn, stores) {
      if (error) {
        if (DEBUG) debug(error);
        aRequest.notifyMarkMessageReadFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
        return;
      }
      txn.onerror = function onerror(event) {
        if (DEBUG) debug("Caught error on transaction ", event.target.errorCode);
        aRequest.notifyMarkMessageReadFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      };
      let messageStore = stores[0];
      let mostRecentStore = stores[1];
      messageStore.get(messageId).onsuccess = function onsuccess(event) {
        let messageRecord = event.target.result;
        if (!messageRecord) {
          if (DEBUG) debug("Message ID " + messageId + " not found");
          aRequest.notifyMarkMessageReadFailed(Ci.nsISmsRequest.NOT_FOUND_ERROR);
          return;
        }
        if (messageRecord.id != messageId) {
          if (DEBUG) {
            debug("Retrieve message ID (" + messageId + ") is " +
                  "different from the one we got");
          }
          aRequest.notifyMarkMessageReadFailed(Ci.nsISmsRequest.UNKNOWN_ERROR);
          return;
        }
        // If the value to be set is the same as the current message `read`
        // value, we just notify successfully.
        if (messageRecord.read == value) {
          if (DEBUG) debug("The value of messageRecord.read is already " + value);
          aRequest.notifyMessageMarkedRead(messageRecord.read);
          return;
        }
        messageRecord.read = value ? FILTER_READ_READ : FILTER_READ_UNREAD;
        messageRecord.readIndex = [messageRecord.read, messageRecord.timestamp];
        if (DEBUG) debug("Message.read set to: " + value);
        messageStore.put(messageRecord).onsuccess = function onsuccess(event) {
          if (DEBUG) {
            debug("Update successfully completed. Message: " +
                  JSON.stringify(event.target.result));
          }

          // Now update the unread count.
          let number = getNumberFromRecord(messageRecord);

          mostRecentStore.get(number).onsuccess = function(event) {
            let mostRecentRecord = event.target.result;
            mostRecentRecord.unreadCount += value ? -1 : 1;
            if (DEBUG) {
              debug("Updating unreadCount for '" + number + "': " +
                    (value ?
                     mostRecentRecord.unreadCount + 1 :
                     mostRecentRecord.unreadCount - 1) +
                    " -> " + mostRecentRecord.unreadCount);
            }
            mostRecentStore.put(mostRecentRecord).onsuccess = function(event) {
              aRequest.notifyMessageMarkedRead(messageRecord.read);
            };
          };
        };
      };
    }, [MESSAGE_STORE_NAME, MOST_RECENT_STORE_NAME]);
  },
  getThreadList: function getThreadList(aRequest) {
    if (DEBUG) debug("Getting thread list");
    this.newTxn(READ_ONLY, function (error, txn, mostRecentStore) {
      if (error) {
        if (DEBUG) debug(error);
        aRequest.notifyThreadListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
        return;
      }
      txn.onerror = function onerror(event) {
        if (DEBUG) debug("Caught error on transaction ", event.target.errorCode);
        aRequest.notifyThreadListFailed(Ci.nsISmsRequest.INTERNAL_ERROR);
      };
      mostRecentStore.index("timestamp").mozGetAll().onsuccess = function(event) {
        aRequest.notifyThreadList(event.target.result);
      };
    }, [MOST_RECENT_STORE_NAME]);
  }
};

XPCOMUtils.defineLazyGetter(MobileMessageDatabaseService.prototype, "mRIL", function () {
    return Cc["@mozilla.org/telephony/system-worker-manager;1"]
              .getService(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIRadioInterfaceLayer);
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([MobileMessageDatabaseService]);

function debug() {
  dump("MobileMessageDatabaseService: " + Array.slice(arguments).join(" ") + "\n");
}
