// :copyright: Copyright (c) 2023 ftrack

import { Event } from "../source/event";
import { describe, expect, it } from "vitest";

describe("Event class", () => {
  it("should initialize with correct topic and data", () => {
    const event = new Event("testTopic", { key: "value" });
    const data = event.getData();
    expect(data.topic).toBe("testTopic");
    expect(data.data).toEqual({ key: "value" });
  });

  it("should have default properties", () => {
    const event = new Event("testTopic", { key: "value" });
    const data = event.getData();
    expect(data.target).toBe("");
    expect(data.inReplyToEvent).toBeNull();
  });

  it("should set properties from options", () => {
    const event = new Event(
      "testTopic",
      { key: "value" },
      { target: "sampleTarget", customOption: "customValue" }
    );
    const data = event.getData();
    expect(data.target).toBe("sampleTarget");
    expect(data.customOption).toBe("customValue");
  });

  it("should generate unique UUID", () => {
    const event1 = new Event("testTopic", { key: "value" });
    const event2 = new Event("testTopic", { key: "value" });
    const data1 = event1.getData();
    const data2 = event2.getData();
    const uuidRegexExp =
      /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/gi;
    expect(data1.id).not.toBe(data2.id);
    expect(uuidRegexExp.test(data1.id)).toBe(true);
  });

  it("should add source to event data", () => {
    const event = new Event("testTopic", { key: "value" });
    event.addSource("sampleSource");
    const data = event.getData();
    expect(data.source).toBe("sampleSource");
  });
});
