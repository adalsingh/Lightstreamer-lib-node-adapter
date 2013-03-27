/**
 * @module lightstreamer-adapter/dataprovider
 */

// Module imports
var EventEmitter = require('events').EventEmitter,
	proto = require('./dataprotocol').data,
	DataReader = require('./dataprotocol').DataReader,
	inspect = require('util').inspect;

/**
 * Data provider constructor.<br>
 * This object extends the EventEmmitter object and emmits the following events:
 * <ul>
 * <li>subscribe: function(itemName, response) {}</li>
 * <li>unsubscribe: function(itemName, response) {}</li>
 * </ul>
 * The response argument is a DataResponse object and one of its methods, error or success, must be called
 * in order to reply to the request bound to the event.
 * @class
 * @param {Stream} reqRespStream the request/reply stream channel to the remote LS proxy adapter
 * @param {Stream} notifyStream the asynchronous stream channel to the remote LS proxy adapter
 * @param {Funcion} [isSnapshotAvailable] optional callback the receive an itemName as argument and must return
 * a boolean value asserting if the iteam supports snapshot. The default value is function(itemName) {return false;}
 */
function DataProvider(reqRespStream, notifyStream, isSnapshotAvailable) {

	var 
		// the ref to the object that is being constructed
		that,
		
		// registered handlers for the incoming messages
		handlers,

		// track active subscriptions and the request id's
		// subscritions[ITEM_NAME] = RQUEST_ID
		subscritions = {},

		// track subscribe/unsubscribe requests
		// subUnsubQueue[ITEM_NAME] = [{message, response}, ...]
		subUnsubQueue = {},

		// the data in parser
		reader = new DataReader();

	// Default value for snapshot callback
	isSnapshotAvailable = isSnapshotAvailable || function(itemName) {return false;}; 

	// Init streams
	reqRespStream.setEncoding("utf8");
	reqRespStream.on('data', handleIncomingMessage);
	notifyStream.setEncoding("utf8");

	/**
	 * Callback for the incoming data from the stream
	 *
	 * @param {String} data the incoming request string
	 * @private
	 */
	function handleIncomingMessage(data) {
		var message;
		reader.parse(data);
		while (!reader.isEmpty()) {
			message = reader.pop();
			// console.log("IN MESSAGE: " + inspect(messages[i]));
			handlers[message.verb](message);
		}
	}

	/**
	 * Write to reqResp stream
	 *
	 * @param {String} data the message string
	 * @private
	 */
	function reply(data) {
		// console.log("REPLY MESSAGE: " + inspect(data));
		reqRespStream.write(data);
	}

	/**
	 * Write to notify stream
	 *
	 * @param {String} data the message string
	 * @private
	 */
	function notify(data) {
		// console.log("NOTIFY MESSAGE: " + inspect(data));
		notifyStream.write(data);
	}

	/**
	 * Sends a subscribe reply
	 *
	 * @param {Object} message the decoded request message
	 * @private
	 */
	function subscribe(message) {
		reply(proto.writeSubscribe(message.id));
		subscritions[message.itemName] = message.id;
		if (!isSnapshotAvailable(message.itemName)) {
			notify(proto.writeEndOfSnapshot(message.id, message.itemName));		
		}
		dequeueSubUnsubRequest(message.itemName);			
		fireFirstSubUnsubEvent(message.itemName);
	}

	/**
	 * Sends a subscribe error reply
	 *
	 * @param {Object} message the decoded request message
	 * @private
	 */
	function subscribeError(message, exceptionMessage) {
		reply(proto.writeSubscribeException(
			message.id, exceptionMessage));				
		dequeueSubUnsubRequest(message.itemName);			
		fireFirstSubUnsubEvent(message.itemName);
	}

	/**
	 * Sends an unsubscribe reply
	 *
	 * @param {Object} message the decoded request message
	 * @private
	 */
	function unsubscribe(message) {
		reply(proto.writeUnsubscribe(message.id));				
		subscritions[message.itemName] = undefined;
		dequeueSubUnsubRequest(message.itemName);			
		handleLateSubUnsubRequests(message.itemName);	
		fireFirstSubUnsubEvent(message.itemName);
	}

	/**
	 * Sends an unsubscribe error reply
	 *
	 * @param {Object} message the decoded request message
	 * @private
	 */
	function unsubscribeError(message, exceptionMessage) {
		reply(proto.writeUnsubscribeException(
			message.id, exceptionMessage));
		dequeueSubUnsubRequest(message.itemName);			
		fireFirstSubUnsubEvent(message.itemName);
	}

	/**
	 * Add a subscribe/unsubscribe request to the queue
	 *
	 * @param {Object} message the decoded request message
	 * @param {DataResponse} reponse the response object
	 * @private
	 */
	function queueSubUnsubRequest(message, reponse) {
		if (typeof subUnsubQueue[message.itemName] === 'undefined') {
			subUnsubQueue[message.itemName] = [];
		}
		subUnsubQueue[message.itemName].push({'message': message, 'response': reponse});			
		return subUnsubQueue[message.itemName].length;
	}

	/**
	 * Remove a subscribe/unsubscribe request from the queue
	 *
	 * @param {String} itemName the item name
	 * @private
	 */
	function dequeueSubUnsubRequest(itemName) {		
		subUnsubQueue[itemName].shift();
	}

	/**
	 * Fire the first event in the queue
	 *
	 * @param {String} itemName the item name
	 * @private
	 */
	function fireFirstSubUnsubEvent(itemName) {
		if (subUnsubQueue[itemName].length > 0) {
			request = subUnsubQueue[itemName][0];
			that.emit(request.message.verb, itemName, request.response);								
		}
	}

	/**
	 * Handle late item sub/unsub requests
	 *
	 * @param {String} itemName the item name
	 * @private
	 */
	function handleLateSubUnsubRequests(itemName) {
		var queue = subUnsubQueue[itemName];
		// It expects that the items in the queue
		// are in the following sequence SUSUSU[S]
		// (the function is called after a successful unsub reply)
		while (queue.length > 1) {
			// Send error to the sub request
			var request = queue.shift();
			reply(proto.writeSubscribeException(
				request.message.id, "Subscribe request come too late"));
			// Send ok to the unsub request
			request = queue.shift();
			reply(proto.writeUnsubscribe(request.message.id));
		}			
	}


	handlers = {
		/**
		 * Handles a subscribe request creating a DataResponse Object and
		 * emitting the subscribe event.
		 *
		 * @param {Object} message the incoming request associative array
		 * @private
		 */
		'subscribe' : function(message) {
			var response = new DataResponse(message, subscribe, subscribeError);
			if (queueSubUnsubRequest(message, response) === 1) {
				fireFirstSubUnsubEvent(message.itemName);
			} else {
				that.emit("subscribeInQueue", message.itemName);	
			}
		},
		/**
		 * Handles an unsubscribe request creating a DataResponse Object and
		 * emitting the unsubscribe event.
		 *
		 * @param {Object} message the incoming request associative array
		 * @private
		 */
		'unsubscribe' : function(message) {
			var response = new DataResponse(message, unsubscribe, unsubscribeError);
			if (queueSubUnsubRequest(message, response) === 1) {
				fireFirstSubUnsubEvent(message.itemName);
			} else {
				that.emit("unsubscribeInQueue", message.itemName);				
			}
		}
	};

	/**
	 * Sends an update for a particular item to the remote LS proxy.
	 *
	 * @param {String} itemName the item name
	 * @param {Boolean} isSnapshot is it a snapshot?
	 * @param {Object} data an associative array of strings
	 * that represents the data to be published
	 */
	function update(itemName, isSnapshot, data) {
		var message, id = getIdFromItemName(itemName);
		message = proto.writeUpdate(id, itemName, isSnapshot, data);
		notify(message);
		return that;		
	}

	/**
	 * Sends an end of snapshot message for a particular item to the remote LS proxy.
	 *
	 * @param {String} itemName the item name
	 */
	function endOfSnapshot(itemName) {
		var message, id = getIdFromItemName(itemName);
		message = proto.writeEndOfSnapshot(id, itemName);
		notify(message);
		return that;		
	}

	/**
	 * Sends a failure message to the remote LS proxy.
	 *
	 * @param {String} exception the exception message
	 */
	function failure(exception) {
		var message;
		message = proto.writeFailure(exception);
		notify(message);
		return that;		
	}

	/**
	 * Returns a request id for an item name
	 *
	 * @param {String} itemName the item name
	 * @private
	 */
	function getIdFromItemName(itemName) {
		var id = subscritions[itemName];
		if (typeof id === "undefined") {
			throw new Error('Item [' + itemName + '] is not subscribed');	
		} else {
			return id;
		}
	}

	/**
	 * Returns the configured notify stream.
	 *
	 * @return Object the stream 
	 */
	function getNotifyStream() {
		return notifyStream;
	}

	/**
	 * Returns the configured request/reply stream.
	 *
	 * @return Object the stream 
	 */
	function getReqRespStream() {
		return reqRespStream;
	}

	// Public methods
	that = {
		update: update,
		endOfSnapshot: endOfSnapshot,
		failure: failure,
		notifyStream: getNotifyStream,
		reqRespStream: getReqRespStream
	};
	
	// The object extends the standard EventEmitter
	that.__proto__ = EventEmitter.prototype;

	return that;
}

/**
 * <p>DataResponse constructor.
 * An instance of this class is passed as argument to an event listener,
 * and must be used to respond to the remote adapter request,
 * using the success method or the error method.</p>
 *
 * @class
 * @param {Object} message the request data
 * @param {Function} successHandler a callback to the DataProvider function for a successful response
 * @param {Function} errorHandler a callback to the DataProvider function for an error response
 */
function DataResponse(message, successHandler, errorHandler) {

	var isUsed = false;

	/**
	 * Sends a successful reponse.
	 */
	function success() {
		checkIfUsed();
		successHandler.call(that, message);
	}

	/**
	 * Sends an error reponse.
	 *
	 * @param {String} exceptionMessage exception message
	 */
	function error(exceptionMessage) {
		checkIfUsed();
		errorHandler.call(that, message, exceptionMessage);
	}

	function checkIfUsed() {
		if (isUsed){
			throw new Error("Response for request " + message.id + " has been already used");
		} else {
			isUsed = true;
		}		
	}

	// Public methods
	that = {
		error: error,
		success: success
	};


	return that;
}

// Module exports
exports.DataProvider = DataProvider;