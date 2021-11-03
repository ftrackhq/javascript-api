import { rest } from "msw";
import { setupServer } from "msw/node";
import fs from "fs/promises";
import querySchemas from "./fixtures/query_schemas.json";
import queryServerInformation from "./fixtures/query_server_information.json";
import getUploadMetadata from "./fixtures/get_upload_metadata.json";

function authenticate(req) {
  // allow returning invalid authentication by setting ftrack-api-key to "INVALID_API_KEY"
  // otherwise, return true
  if (req.headers.get("ftrack-api-key") === "INVALID_API_KEY") {
    return false;
  }
  return true;
}

const handlers = [
  rest.post("http://ftrack.test/api", async (req, res, ctx) => {
    if (!authenticate(req)) {
      return res(
        ctx.json({
          content:
            'The supplied API key is not valid. API keys are created from Settings under the page API keys. The api key should be passed in the request header "ftrack-api-key".',
          exception: "InvalidCredentialsError",
          error_code: null,
        })
      );
    }
    const body = await Promise.all(
      req.body.map(async ({ action, expression, entity_type: entityType }) => {
        switch (action) {
          case "query_server_information":
            return queryServerInformation;
          case "query_schemas":
            return querySchemas;
          case "create":
            // create are fetched from test/fixtures where the file name matches the full expression
            return JSON.parse(
              await fs.readFile(
                `${__dirname}/fixtures/create_${entityType.toLowerCase()}.json`,
                {
                  encoding: "utf-8",
                }
              )
            );
          case "delete":
            return {
              action: "delete",
              data: true,
            };
          case "update":
            // update are fetched from test/fixtures where the file name matches the full expression
            return JSON.parse(
              await fs.readFile(
                `${__dirname}/fixtures/update_${entityType.toLowerCase()}.json`,
                {
                  encoding: "utf-8",
                }
              )
            );
          case "query":
            // queries are fetched from test/fixtures where the file name matches the full expression
            return JSON.parse(
              await fs.readFile(
                `${__dirname}/fixtures/query_${expression
                  .toLowerCase()
                  .split(" ")
                  .join("_")}.json`,
                { encoding: "utf-8" }
              )
            );
          case "get_upload_metadata":
            return getUploadMetadata;

          default:
            throw new Error("Action not supported by test server.");
        }
      })
    );
    return res(ctx.json(body));
  }),
  rest.options("http://ftrack.test/file-url", async (req, res, ctx) => {
    return res(
      ctx.status(200),
      ctx.set("Access-Control-Allow-Origin", "*"),
      ctx.body("file")
    );
  }),
  rest.put("http://ftrack.test/file-url", async (req, res, ctx) => {
    return res(ctx.status(200), ctx.set("Access-Control-Allow-Origin", "*"));
  }),
];

const server = setupServer(...handlers);

export { server, rest };
