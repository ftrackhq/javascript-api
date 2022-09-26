// :copyright: Copyright (c) 2016 ftrack
import { beforeAll, afterAll, vi } from "vitest";

import { v4 as uuidV4 } from "uuid";
import loglevel from "loglevel";
import moment from "moment";
import {
  ServerPermissionDeniedError,
  ServerValidationError,
  ServerError,
} from "../source/error";
import { Session } from "../source/session";
import operation from "../source/operation";
import { server } from "./server";
import { expect } from "chai";

const logger = loglevel.getLogger("test_session");
logger.setLevel("debug");

const credentials = {
  serverUrl: "http://ftrack.test",
  apiUser: "testuser",
  apiKey: "testkey",
};
let session = null;

beforeAll(() => {
  session = new Session(
    credentials.serverUrl,
    credentials.apiUser,
    credentials.apiKey,
    {
      autoConnectEventHub: false,
    }
  );
});

describe("Session", () => {
  logger.debug("Running session tests.");

  it("Should initialize the session automatically", async () => {
    await expect(session.initializing).resolves.toBeTruthy();
  });

  it("Should reject invalid credentials", async () => {
    const badSession = new Session(
      credentials.serverUrl,
      credentials.apiUser,
      "INVALID_API_KEY",
      {
        autoConnectEventHub: false,
      }
    );
    await expect(badSession.initializing).rejects.toThrow(ServerError);
  });

  it("Should allow querying a Task", () =>
    expect(
      session
        .query("select name from Task limit 1")
        .then((response) => response.data[0].__entity_type__)
    ).resolves.toEqual("Task"));

  it("Should allow creating a User", () => {
    const promise = session.create("User", {
      username: uuidV4(),
    });

    return expect(
      promise.then((response) => response.data.__entity_type__)
    ).resolves.toEqual("User");
  });

  it("Should allow deleting a User", async () => {
    const username = uuidV4();
    let promise = session.create("User", {
      username,
    });

    promise = promise.then((newUserResponse) => {
      const userId = newUserResponse.data.id;
      const deletePromise = session.delete("User", userId);
      return deletePromise;
    });

    await expect(
      promise.then((response) => response.data)
    ).resolves.toBeTruthy();
  });

  it("Should allow updating a User", async () => {
    const username = "new user";
    const newUsername = "3e21c60e-33ac-4242-aaf8-b04a089821c7";
    let promise = session.create("User", {
      username,
    });

    promise = promise.then((newUserResponse) => {
      const userId = newUserResponse.data.id;
      const updatePromise = session.update("User", userId, {
        username: newUsername,
      });

      return updatePromise;
    });

    await expect(
      promise.then((response) => response.data.username)
    ).resolves.toEqual(newUsername);
  });

  it("Should support merging 0-level nested data", async () => {
    await session.initializing;
    const data = session.decode([
      {
        id: 1,
        __entity_type__: "Task",
        name: "foo",
      },
      {
        id: 1,
        __entity_type__: "Task",
      },
      {
        id: 2,
        __entity_type__: "Task",
        name: "bar",
      },
    ]);
    expect(data[0].name).toEqual("foo");
    expect(data[1].name).toEqual("foo");
    expect(data[2].name).toEqual("bar");
  });

  it("Should support merging 1-level nested data", async () => {
    await session.initializing;
    const data = session.decode([
      {
        id: 1,
        __entity_type__: "Task",
        name: "foo",
        status: {
          __entity_type__: "Status",
          id: 2,
          name: "In progress",
        },
      },
      {
        id: 2,
        __entity_type__: "Task",
        name: "foo",
        status: {
          __entity_type__: "Status",
          id: 1,
          name: "Done",
        },
      },
      {
        id: 3,
        __entity_type__: "Task",
        status: {
          __entity_type__: "Status",
          id: 1,
        },
      },
    ]);
    expect(data[0].status.name).toEqual("In progress");
    expect(data[1].status.name).toEqual("Done");
    expect(data[2].status.name).toEqual("Done");
  });

  it("Should support merging 2-level nested data", async () => {
    await session.initializing;
    const data = session.decode([
      {
        id: 1,
        __entity_type__: "Task",
        name: "foo",
        status: {
          __entity_type__: "Status",
          id: 1,
          state: {
            __entity_type__: "State",
            id: 1,
            short: "DONE",
          },
        },
      },
      {
        id: 2,
        __entity_type__: "Task",
        status: {
          __entity_type__: "Status",
          id: 2,
          state: {
            __entity_type__: "State",
            id: 2,
            short: "NOT_STARTED",
          },
        },
      },
      {
        id: 3,
        __entity_type__: "Task",
        status: {
          __entity_type__: "Status",
          id: 1,
          state: {
            __entity_type__: "State",
            id: 1,
          },
        },
      },
    ]);
    expect(data[0].status.state.short).toEqual("DONE");
    expect(data[1].status.state.short).toEqual("NOT_STARTED");
    expect(data[2].status.state.short).toEqual("DONE");
  });

  it("Should support api query 2-level nested data", async () => {
    const response = await session.query(
      "select status.state.short from Task where status.state.short is NOT_STARTED limit 2"
    );
    const { data } = response;
    expect(data[0].status.state.short).toEqual("NOT_STARTED");
    expect(data[1].status.state.short).toEqual("NOT_STARTED");

    expect(data[0].status.state).toEqual(data[1].status.state);
  });

  it("Should decode batched query operations", async () => {
    const responses = await session.call([
      operation.query(
        "select status.state.short from Task where status.state.short is NOT_STARTED limit 1"
      ),
      operation.query(
        "select status.state.short from Task where status.state.short is NOT_STARTED limit 1"
      ),
    ]);
    const status1 = responses[0].data[0].status;
    const status2 = responses[1].data[0].status;
    expect(status1.state.short).toEqual("NOT_STARTED");
    expect(status2.state.short).toEqual("NOT_STARTED");
    expect(status1).toEqual(status2);
  });

  it("Should decode self-referencing entities", async () => {
    const response = await session.query(
      "select version, asset.versions.version from AssetVersion where asset_id is_not None limit 1"
    );

    const versionNumber = response.data[0].version;
    const versionId = response.data[0].id;
    const assetVersions = response.data[0].asset.versions;
    const versionNumber2 = assetVersions.find(
      (item) => item.id === versionId
    ).version;
    expect(versionNumber).toEqual(versionNumber2);
  });

  it.skip("Should support uploading files", async () => {
    const data = { foo: "bar" };
    const blob = new Blob([JSON.stringify(data)], {
      type: "application/json",
    });
    blob.name = "data.json";

    const response = await session.createComponent(blob);
    expect(response[0].data.__entity_type__).toEqual("FileComponent");
    expect(response[0].data.file_type).toEqual(".json");
    expect(response[0].data.name).toEqual("data");

    // TODO: Read file back and verify the data. This is currently not
    // possible due to being a cors request.
  });

  it.skip("Should support abort of uploading file", async () => {
    const data = { foo: "bar" };
    const blob = new Blob([JSON.stringify(data)], {
      type: "application/json",
    });
    blob.name = "data.json";
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve) => {
      const onAborted = () => {
        resolve(true);
      };

      session.createComponent(blob, {
        xhr,
        onProgress: () => {
          xhr.abort();
        },
        onAborted,
      });
    });
    expect(promise).resolves.toBeTruthy();
  });

  it.skip("Should support ensure with create", async () => {
    const identifyingKeys = ["key", "parent_id", "parent_type"];
    const key = uuidV4();

    let user;
    await session.initializing;
    const { data } = await session.query(
      `select id from User where username is "${session.apiUser}"`
    );
    user = data[0];
    const ensuredData = await session.ensure(
      "Metadata",
      {
        key,
        value: "foo",
        parent_id: user.id,
        parent_type: "User",
      },
      identifyingKeys
    );
    expect(ensuredData.__entity_type__).toEqual("Metadata");
    expect(ensuredData.key).toEqual(key);
    expect(ensuredData.value).toEqual("foo");
    expect(ensuredData.parent_id).toEqual(user.id);
    expect(ensuredData.parent_type).toEqual("User");
  });

  it.skip("Should support ensure with update", async (done) => {
    const identifyingKeys = ["key", "parent_id", "parent_type"];
    const key = uuidV4();

    let user;
    const promise = session.initializing
      .then(() =>
        session.query(
          `select id from User where username is "${session.apiUser}"`
        )
      )
      .then(({ data }) => {
        user = data[0];
        return session.create("Metadata", {
          key,
          value: "foo",
          parent_id: user.id,
          parent_type: "User",
        });
      })
      .then(() =>
        session.ensure(
          "Metadata",
          {
            key,
            value: "bar",
            parent_id: user.id,
            parent_type: "User",
          },
          identifyingKeys
        )
      );
    promise
      .then((data) => {
        try {
          data.__entity_type__.should.equal("Metadata");
          data.key.should.equal(key);
          data.value.should.equal("bar");
          data.parent_id.should.equal(user.id);
          data.parent_type.should.equal("User");
        } catch (error) {
          done(error);
        }
      })
      .then(done);
  });

  it.skip("Should support ensure with update moment object as criteria", async (done) => {
    const now = moment();

    const name = uuidV4();

    const promise = session.initializing
      .then(() =>
        session.create("Project", {
          start_date: now,
          end_date: now,
          name,
          full_name: "foo",
        })
      )
      .then(() =>
        session.ensure(
          "Project",
          {
            start_date: now,
            end_date: now,
            name,
            full_name: "bar",
          },
          ["start_date"]
        )
      );
    promise
      .then((data) => {
        try {
          data.__entity_type__.should.equal("Project");
          data.full_name.should.equal("bar");
        } catch (error) {
          done(error);
        }
      })
      .then(done);
  });

  it.skip("Should support uploading files with custom component id", async (done) => {
    const componentId = uuidV4();
    const data = { foo: "bar" };
    const blob = new Blob([JSON.stringify(data)], {
      type: "application/json",
    });
    blob.name = "data.json";

    const promise = session.createComponent(blob, {
      data: { id: componentId },
    });
    promise
      .then((response) => {
        response[0].data.id.should.equal(componentId);
      })
      .then(done);
  });

  it("Should support generating thumbnail URL with + in username", () => {
    const componentId = uuidV4();
    const previousUser = session.apiUser;
    session.apiUser = "user+test@example.com";
    const url = session.thumbnailUrl(componentId);
    expect(url).toEqual(
      `${credentials.serverUrl}/component/thumbnail?` +
        `id=${componentId}&size=300` +
        `&username=${encodeURIComponent(session.apiUser)}` +
        `&apiKey=${credentials.apiKey}`
    );
    session.apiUser = previousUser;
  });

  it("Should support encoding moment dates", () => {
    const now = moment();
    const output = session.encode([{ foo: now, bar: "baz" }, 12321]);
    expect(output).toEqual([
      {
        foo: {
          __type__: "datetime",
          value: now.format("YYYY-MM-DDTHH:mm:ss"),
        },
        bar: "baz",
      },
      12321,
    ]);
  });

  it("Should return correct error", () => {
    expect(
      session.getErrorFromResponse({
        exception: "PermissionError",
        content: "foo",
      })
    ).toBeInstanceOf(ServerPermissionDeniedError);
    expect(
      session.getErrorFromResponse({
        exception: "FTAuthenticationError",
        content: "foo",
      })
    ).toBeInstanceOf(ServerPermissionDeniedError);
    expect(
      session.getErrorFromResponse({
        exception: "ValidationError",
        content: "foo",
      })
    ).toBeInstanceOf(ServerValidationError);
    expect(
      session.getErrorFromResponse({
        exception: "Foo",
        content: "foo",
      })
    ).toBeInstanceOf(ServerError);
  });
});
