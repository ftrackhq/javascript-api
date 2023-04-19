// :copyright: Copyright (c) 2023 ftrack
import { describe, test, vi } from "vitest";
import SimpleSocketIOClient, { PACKET_TYPES } from "../source/simple_socketio";
const credentials = {
  serverUrl: "http://ftrack.test",
  apiUser: "testuser",
  apiKey: "testkey",
};
function createWebSocketMock() {
  return {
    addEventListener: vi.fn(),
    send: vi.fn(),
  };
}
function createClient(options) {
  return new SimpleSocketIOClient(
    options.serverUrl || credentials.serverUrl,
    options.apiUser || credentials.apiUser,
    options.apiKey || credentials.apiKey,
    options.heartbeatIntervalMs || undefined
  );
}

describe("Tests using SimpleSocketIOClient", () => {
  let client;

  beforeEach(() => {
    client = createClient({});
  });
  afterEach(() => {
    client = undefined;
  });

  test("SimpleSocketIOClient initializes properties correctly", () => {
    // Assertions
    expect(client.serverUrl).toBe(credentials.serverUrl);
    expect(client.wsUrl).toBe(credentials.serverUrl.replace(/^(http)/, "ws"));
    expect(client.query).toMatch(credentials.apiUser);
    expect(client.query).toMatch(credentials.apiKey);
    expect(client.handlers).toEqual({});
    expect(client.apiUser).toBe(credentials.apiUser);
    expect(client.apiKey).toBe(credentials.apiKey);
    expect(client.socket).toMatchObject({
      connected: false,
      transport: null,
    });
  });
  test("initializeWebSocket should set the fetched session ID correctly", async () => {
    // Call the initializeWebSocket method
    await client.initializeWebSocket();

    // Check if the session ID is fetched correctly
    expect(client.sessionId).toBe("1234567890");
  });

  test("SimpleSocketIOClient initializes custom heartbeatIntervalMs correctly", () => {
    const heartbeatClient = createClient({
      heartbeatIntervalMs: 1990,
    });
    expect(heartbeatClient.heartbeatIntervalMs).toBe(1990);
  });

  test.skip("isConnected returns false when WebSocket is not initialized", () => {
    // TODO: Figure out how to handle error throw testing.

    let connected;
    try {
      const client = new SimpleSocketIOClient(
        credentials.serverUrl,
        credentials.apiUser,
        "INVALID_API_KEY"
      );
      connected = client.isConnected();
    } catch (error) {
      connected = false;
    }
    expect(connected).toBe(false);
  });

  test("on method registers event callback correctly", () => {
    const callback = () => {};

    client.on("testEvent", callback);
    expect(client.handlers["testEvent"]).toContain(callback);
  });

  test("SimpleSocketIOClient initializes properties correctly with HTTPS URL", () => {
    const httpsClient = createClient({ serverUrl: "https://ftrack.test" });
    expect(httpsClient.serverUrl).toBe("https://ftrack.test");
    expect(httpsClient.wsUrl).toBe("wss://ftrack.test");
  });
  test("emit method correctly sends event to server", () => {
    client.ws = createWebSocketMock();
    // Set the readyState to OPEN, to simulate an open connection
    client.ws.readyState = WebSocket.OPEN;

    const eventName = "testEvent";
    const eventData = { foo: "bar" };

    // Call the emit method
    client.emit(eventName, eventData);

    // Check that the correct payload is sent to the server
    const expectedPayload = {
      name: eventName,
      args: [eventData],
    };
    const expectedDataString = `:::${JSON.stringify(expectedPayload)}`;
    expect(client.ws.send).toHaveBeenCalledWith(
      `${PACKET_TYPES.event}${expectedDataString}`
    );
  });
  test("handleError method correctly handles WebSocket errors and calls handleClose method", () => {
    client.ws = createWebSocketMock();
    vi.spyOn(client, "handleClose");
    vi.spyOn(global.console, "error");

    // Call handleError method with mock event
    const mockEvent = { type: "error" };
    client.handleError(mockEvent);

    expect(client.handleClose).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("WebSocket error:", mockEvent);
  });

  test("reconnect method runs the ws close method and then initialises websocket again", async () => {
    vi.spyOn(client, "initializeWebSocket");

    // Initialize the WebSocket and set the connected property to true
    await client.initializeWebSocket();
    client.socket.connected = true;

    // Create a mock WebSocket with a spied close method
    const closeMock = vi.fn();
    client.ws.close = closeMock;

    // Call the reconnect method
    client.reconnect();

    // Check that closemock was called and that the initializeWebSocket method was called again
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(client.initializeWebSocket).toHaveBeenCalledTimes(2);
  });
  describe("handleMessage", () => {
    test("handleMessage correctly handles event packet type", () => {
      const eventName = "testEvent";
      const eventData = { foo: "bar" };
      const packetData = JSON.stringify({ name: eventName, args: [eventData] });

      vi.spyOn(client, "handleEvent");

      client.handleMessage({ data: `${PACKET_TYPES.event}:::${packetData}` });

      expect(client.handleEvent).toHaveBeenCalledWith(eventName, eventData);
    });

    test("handleMessage correctly handles heartbeat packet type", () => {
      client.ws = createWebSocketMock();

      client.handleMessage({ data: `${PACKET_TYPES.heartbeat}::` });

      expect(client.ws.send).toHaveBeenCalledWith(
        `${PACKET_TYPES.heartbeat}::`
      );
    });

    test("handleMessage correctly handles error packet type", () => {
      vi.spyOn(client, "handleClose");
      vi.spyOn(global.console, "log");

      const errorMsg = "WebSocket message error";
      const mockEvent = { data: `${PACKET_TYPES.error}::${errorMsg}` };

      client.handleMessage(mockEvent);

      expect(console.log).toHaveBeenCalledWith(errorMsg + ": ", mockEvent);
      expect(client.handleClose).toHaveBeenCalledTimes(1);
    });

    //TOOD: What should happen for unknown packet types?
  });
  test("handleEvent method calls the correct callback(s) with the correct eventData", () => {
    const eventName1 = "testEvent1";
    const eventName2 = "testEvent2";
    const eventData1 = { foo: "bar" };
    const eventData2 = { bar: "baz" };

    const callback1 = vi.fn();
    const callback2 = vi.fn();

    client.on(eventName1, callback1);
    client.on(eventName2, callback2);

    // Call the handleEvent method with eventName1 and eventData1
    client.handleEvent(eventName1, eventData1);

    // Check that callback1 was called with eventData1 and callback2 was not called
    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback1).toHaveBeenCalledWith(eventData1);
    expect(callback2).toHaveBeenCalledTimes(0);

    // Call the handleEvent method with eventName2 and eventData2
    client.handleEvent(eventName2, eventData2);

    // Check that callback2 was called with eventData2 and callback1 was called only once before
    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledWith(eventData2);
  });
  test("handleOpen method works as expected", () => {
    vi.spyOn(client, "startHeartbeat");
    vi.spyOn(client, "handleEvent");
    // Setup timeout mocks
    const fakeTimeoutId = 12345;
    const setTimeoutMock = vi.fn(() => fakeTimeoutId);
    const clearTimeoutMock = vi.fn();
    global.setTimeout = setTimeoutMock;
    global.clearTimeout = clearTimeoutMock;
    client.reconnectTimeout = setTimeoutMock();

    client.handleOpen();

    // Check that the correct methods were called and that the reconnectTimeout was cleared
    expect(client.startHeartbeat).toHaveBeenCalledTimes(1);
    expect(clearTimeoutMock).toHaveBeenCalledWith(fakeTimeoutId);
    expect(client.reconnectTimeout).toBeUndefined();
    expect(client.handleEvent).toHaveBeenCalledWith("connect", {});
    expect(client.socket.connected).toBe(true);
  });
  describe("handleClose method", () => {
    test("handleClose stops the heartbeat", () => {
      // Spy on stopHeartbeat method
      vi.spyOn(client, "stopHeartbeat");

      // Call handleClose method
      client.handleClose();

      // Check that stopHeartbeat is called
      expect(client.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    test("handleClose schedules reconnect", () => {
      // Spy on scheduleReconnect method
      vi.spyOn(client, "scheduleReconnect");

      // Call handleClose method
      client.handleClose();

      // Check that scheduleReconnect is called
      expect(client.scheduleReconnect).toHaveBeenCalledTimes(1);
    });

    test("handleClose sets socket.connected property to false", () => {
      // Set connected property to true
      client.socket.connected = true;

      // Call handleClose method
      client.handleClose();

      // Check that connected property is set to false
      expect(client.socket.connected).toBe(false);
    });
  });
  test("startHeartbeat and stopHeartbeat correctly set and clear the heartbeat interval", () => {
    vi.useFakeTimers(); // Use fake timers to control setInterval and clearInterval

    // Mock the WebSocket send method
    client.ws = createWebSocketMock();

    // Call the startHeartbeat method and check if the send method is called with the correct arguments
    client.startHeartbeat();
    vi.advanceTimersByTime(client.heartbeatIntervalMs);
    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(client.ws.send).toHaveBeenCalledWith(`${PACKET_TYPES.heartbeat}::`);

    // Advance the time again and check if the send method is called again
    vi.advanceTimersByTime(client.heartbeatIntervalMs);
    expect(client.ws.send).toHaveBeenCalledTimes(2);

    // Call the stopHeartbeat method and check if the send method is not called anymore
    client.stopHeartbeat();
    vi.advanceTimersByTime(client.heartbeatIntervalMs);
    expect(client.ws.send).toHaveBeenCalledTimes(2);

    vi.useRealTimers(); // Reset timers back to normal behavior
  });
  test("scheduleReconnect method schedules reconnect only once and calls reconnect after specified delay", () => {
    vi.useFakeTimers();

    vi.spyOn(client, "reconnect");
    const reconnectDelayMs = 1000;

    // Call scheduleReconnect twice to ensure that it only schedules reconnect once
    client.scheduleReconnect(reconnectDelayMs);
    client.scheduleReconnect(reconnectDelayMs);

    // Move the clock forward by less than the reconnect delay and check that reconnect hasn't been called yet
    vi.advanceTimersByTime(reconnectDelayMs / 2);
    expect(client.reconnect).toHaveBeenCalledTimes(0);

    // Move the clock forward by the remaining reconnect delay and check that reconnect is called exactly once
    vi.advanceTimersByTime(reconnectDelayMs / 2);
    expect(client.reconnect).toHaveBeenCalledTimes(1);

    vi.useRealTimers(); // Reset timers back to normal behavior
  });
  test("Event queue is working", () => {
    client.ws = createWebSocketMock();

    // Disconnect the WebSocket to ensure messages are queued
    client.ws.readyState = WebSocket.CLOSED;
    const eventName = "testEvent";
    const eventData = { foo: "bar" };

    // Call the emit method
    client.emit(eventName, eventData);

    // Check that the correct payload is sent to the server
    const expectedPayload = {
      name: eventName,
      args: [eventData],
    };

    // Check if the event was queued
    expect(client.packetQueue).toHaveLength(1);
    expect(client.ws.send).toHaveBeenCalledTimes(0);
    // Reconnect the WebSocket and ensure the message is sent
    client.ws.readyState = WebSocket.OPEN;
    client.handleOpen();

    // Check if the packetQueue is empty and the message was sent
    expect(client.packetQueue).toHaveLength(0);
    const expectedDataString = `:::${JSON.stringify(expectedPayload)}`;
    expect(client.ws.send).toHaveBeenCalledWith(
      `${PACKET_TYPES.event}${expectedDataString}`
    );
  });
});
