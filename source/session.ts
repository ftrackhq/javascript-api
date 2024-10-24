// :copyright: Copyright (c) 2016 ftrack
import moment from "moment";
import loglevel from "loglevel";
import { v4 as uuidV4 } from "uuid";

import { EventHub } from "./event_hub.js";
import * as operation from "./operation.js";
import {
  ServerPermissionDeniedError,
  ServerValidationError,
  ServerError,
  AbortError,
} from "./error.js";

import type {
  ActionResponse,
  CallOptions,
  CreateComponentOptions,
  CreateResponse,
  Data,
  DefaultEntityTypeMap,
  DeleteResponse,
  GetUploadMetadataResponse,
  IsTuple,
  MutationOptions,
  QueryOptions,
  QueryResponse,
  QuerySchemasResponse,
  QueryServerInformationResponse,
  ResponseError,
  Schema,
  SearchOptions,
  SearchResponse,
  ServerInformation,
  SessionOptions,
  UpdateResponse,
} from "./types.js";
import { convertToIsoString } from "./util/convert_to_iso_string.js";
import { Uploader } from "./uploader.js";
import getSchemaMappingFromSchemas from "./util/get_schema_mapping.js";

const logger = loglevel.getLogger("ftrack_api");

const ENCODE_DATETIME_FORMAT = "YYYY-MM-DDTHH:mm:ss";

/**
 * ftrack API session
 * @class  Session
 *
 */
export class Session<
  TEntityTypeMap extends Record<string, any> = DefaultEntityTypeMap,
> {
  apiUser: string;
  apiKey: string;
  serverUrl: string;
  apiEndpoint: string;
  eventHub: EventHub;
  clientToken: string | null;
  initialized: boolean;
  initializing: Promise<Session<TEntityTypeMap>>;
  additionalHeaders: Data;
  schemas?: Schema<TEntityTypeMap>[];
  serverInformation?: QueryServerInformationResponse;
  serverVersion?: string;
  private ensureSerializableResponse: boolean;
  private decodeDatesAsIso: boolean;
  private schemasPromise?: Promise<Schema<TEntityTypeMap>[]>;
  private serverInformationPromise?: Promise<ServerInformation>;
  private serverInformationValues?: string[];
  private schemaMapping?: {
    [TEntityType in keyof TEntityTypeMap]: Schema<TEntityTypeMap, TEntityType>;
  };

  /**
   * Construct Session instance with API credentials.
   *
   * @param  {string}  serverUrl -                  ftrack server URL
   * @param  {string}  apiUser -                    ftrack username for API user.
   * @param  {string}  apiKey -                     User API Key
   * @param  {Object}  options  -                   options
   * @param  {Boolean} [options.autoConnectEventHub=false] - Automatically connect to event hub,
   * @param  {Array|null} [options.serverInformationValues] - List of server information values to retrieve.
   * @param  {Object}  [options.eventHubOptions={}] - Options to configure event hub with.
   * @param  {string} [options.clientToken] - Client token for update events.
   * @param  {string} [options.apiEndpoint=/api] - API endpoint.
   * @param {object} [options.headers] - Additional headers to send with the request
   * @param {object} [options.strictApi] - Turn on strict API mode
   * @param {object} [options.decodeDatesAsIso] - Decode dates as ISO strings instead of moment objects
   * @param {object} [options.ensureSerializableResponse] - Disable normalization of response data
   *
   * @constructs Session
   */
  constructor(
    serverUrl: string,
    apiUser: string,
    apiKey: string,
    {
      autoConnectEventHub = false,
      serverInformationValues,
      eventHubOptions = {},
      clientToken,
      apiEndpoint = "/api",
      additionalHeaders = {},
      strictApi = false,
      decodeDatesAsIso = false,
      ensureSerializableResponse = false,
    }: SessionOptions = {},
  ) {
    if (!serverUrl || !apiUser || !apiKey) {
      throw new Error(
        "Invalid arguments, please construct Session with " +
          "*serverUrl*, *apiUser* and *apiKey*.",
      );
    }

    /**
     * Username of ftrack user used by API
     * @memberof Session
     * @instance
     * @type {string}
     */
    this.apiUser = apiUser;

    /**
     * API Key
     * @memberof Session
     * @instance
     * @type {string}
     */
    this.apiKey = apiKey;

    /**
     * ftrack server URL
     * @memberof Session
     * @instance
     * @type {string}
     */
    this.serverUrl = serverUrl;

    this.serverInformationValues = serverInformationValues;

    /**
     * API Endpoint. Specified relative to server URL with leading slash.
     * @memberof Session
     * @instance
     * @type {string}
     */
    this.apiEndpoint = apiEndpoint;

    /**
     * allows setting additional headers to be sent with each request
     * @memberof Session
     * @instance
     * @type {Data}
     */
    this.additionalHeaders = additionalHeaders;

    if (strictApi) {
      this.additionalHeaders = {
        ...additionalHeaders,
        "ftrack-strict-api": "true",
      };
    }

    /**
     * session event hub
     * @memberof Session
     * @instance
     * @type {EventHub}
     */
    this.eventHub = new EventHub(serverUrl, apiUser, apiKey, eventHubOptions);

    if (autoConnectEventHub) {
      this.eventHub.connect();
    }

    if (clientToken) {
      this.clientToken = clientToken;
    } else {
      this.clientToken = `ftrack-javascript-api--${uuidV4()}`;
    }

    // Always include is_timezone_support_enabled as required by API.
    // TODO: Remove this in next major.
    if (
      serverInformationValues &&
      !serverInformationValues.includes("is_timezone_support_enabled")
    ) {
      serverInformationValues.push("is_timezone_support_enabled");
    }

    // TODO: remove these operations from session initialization in next major
    const operations: [
      operation.QueryServerInformationOperation,
      operation.QuerySchemasOperation,
    ] = [
      {
        action: "query_server_information",
        values: serverInformationValues,
      },
      { action: "query_schemas" },
    ];

    this.decodeDatesAsIso = decodeDatesAsIso;

    /**
     * By default the API server will return normalized responses, and we denormalize them in the client.
     * This might cause cyclical references in the response data, making it non-JSON serializable.
     * This option allows the user to disable normalization of the response data to ensure serializability.
     * @memberof Session
     * @instance
     * @type {Boolean}
     */
    this.ensureSerializableResponse = ensureSerializableResponse;

    /**
     * true if session is initialized
     * @memberof Session
     * @instance
     * @type {Boolean}
     */
    this.initialized = false;

    const initializingPromise =
      this.call<
        [QueryServerInformationResponse, QuerySchemasResponse<TEntityTypeMap>]
      >(operations);

    /**
     * Resolved once session is initialized.
     * @memberof Session
     * @instance
     * @type {Promise}
     */
    this.initializing = initializingPromise.then((responses) => {
      // TODO: Make this.serverInformation, this.schemas, and this.serverVersion private in next major
      // and require calling getServerInformation, getSchemas, and this.getServerVersion instead.
      this.serverInformation = responses[0];
      this.schemas = responses[1];
      this.schemaMapping = getSchemaMappingFromSchemas(this.schemas);
      this.serverVersion = this.serverInformation.version;
      this.initialized = true;

      return Promise.resolve(this);
    });

    this.serverInformationPromise = initializingPromise
      .then((responses) => responses[0])
      .catch(() => ({}) as ServerInformation);

    this.schemasPromise = initializingPromise
      .then((responses) => responses[1])
      .catch(() => [] as Schema<TEntityTypeMap, keyof TEntityTypeMap>[]);
  }

  /**
   * Get primary key attributes from schema
   *
   * @return {Array|null} List of primary key attributes.
   */
  getPrimaryKeyAttributes(entityType: keyof TEntityTypeMap): string[] | null {
    // Todo: make this async in next major
    if (!this.schemas) {
      logger.warn("Schemas not available.");
      return null;
    }
    const schema = this.schemaMapping?.[entityType];
    if (!schema || !schema.primary_key || !schema.primary_key.length) {
      logger.warn("Primary key could not be found for: ", entityType);
      return null;
    }
    return schema.primary_key;
  }

  /**
   * Get identifying key for *entity*
   *
   * @return {String|null} Identifying key for *entity*
   */
  getIdentifyingKey(entity: Data) {
    const primaryKeys = this.getPrimaryKeyAttributes(entity.__entity_type__);
    if (primaryKeys) {
      return [
        entity.__entity_type__,
        ...primaryKeys.map((attribute: string) => entity[attribute]),
      ].join(",");
    }
    return null;
  }

  /**
   * Return encoded *data* as JSON string.
   *
   * This will translate date, moment, and dayjs  objects into ISO8601 string representation in UTC.
   *
   * @private
   * @param  {*} data  The data to encode.
   * @return {*}      Encoded data
   */
  private encode(data: any): any {
    if (data && data.constructor === Array) {
      return data.map((item) => this.encode(item));
    }

    if (data && data.constructor === Object) {
      const out: Data = {};
      for (const key in data) {
        if (data.hasOwnProperty(key)) {
          out[key] = this.encode(data[key]);
        }
      }

      return out;
    }

    const date = convertToIsoString(data);
    if (date) {
      if (
        this.serverInformation &&
        this.serverInformation.is_timezone_support_enabled
      ) {
        // Ensure that the moment object is in UTC and format
        // to timezone naive string.
        return {
          __type__: "datetime",
          value: date,
        };
      }

      // Ensure that the moment object is in local time zone and format
      // to timezone naive string.
      return {
        __type__: "datetime",
        value: moment(date).local().format(ENCODE_DATETIME_FORMAT),
      };
    }

    return data;
  }

  /** Return error instance from *response*.
   *
   * @private
   * @param  {*} response  A server error response object.
   * @return {*}      error instance.
   */
  private getErrorFromResponse(response: ResponseError) {
    let ErrorClass;

    if (response.exception === "AbortError") {
      ErrorClass = AbortError;
    } else if (response.exception === "ValidationError") {
      ErrorClass = ServerValidationError;
    } else if (
      response.exception === "FTAuthenticationError" ||
      response.exception === "PermissionError"
    ) {
      ErrorClass = ServerPermissionDeniedError;
    } else {
      ErrorClass = ServerError;
    }

    const error = new ErrorClass(response.content, response.error_code);

    return error;
  }

  /**
   * Iterate *data* and decode entities with special encoding logic.
   *
   * Iterates recursively through objects and arrays.
   *
   * Will merge ftrack entities multiple occurrences which have been
   * de-duplicated in the back end and point them to a single object in
   * *identityMap*.
   *
   * datetime objects will be converted to timezone-aware moment objects.
   *
   * @private
   * @param  {*} data  The data to decode.
   * @return {*}      Decoded data
   */

  private decode(
    data: any,
    identityMap: Data = {},
    {
      decodeDatesAsIso = false,
      ensureSerializableResponse = false,
    }: {
      decodeDatesAsIso?: boolean;
      ensureSerializableResponse?: boolean;
    } = {},
  ): any {
    if (Array.isArray(data)) {
      return this._decodeArray(data, identityMap, {
        decodeDatesAsIso,
        ensureSerializableResponse,
      });
    }
    if (!!data && typeof data === "object") {
      if (data.__entity_type__ && !ensureSerializableResponse) {
        return this._mergeEntity(data, identityMap, {
          decodeDatesAsIso,
          ensureSerializableResponse,
        });
      }
      if (data.__type__ === "datetime" && decodeDatesAsIso) {
        return this._decodeDateTimeAsIso(data);
      } else if (data.__type__ === "datetime") {
        return this._decodeDateTimeAsMoment(data);
      }
      return this._decodePlainObject(data, identityMap, {
        decodeDatesAsIso,
        ensureSerializableResponse,
      });
    }
    return data;
  }

  /**
   * Decode datetime *data* into ISO 8601 strings.
   *
   * Translate objects with __type__ equal to 'datetime' into moment
   * datetime objects. If time zone support is enabled on the server the date
   * will be assumed to be UTC and the moment will be in utc.
   * @private
   */
  private _decodeDateTimeAsIso(data: any) {
    let dateValue = data.value;
    if (
      this.serverInformation &&
      this.serverInformation.is_timezone_support_enabled &&
      !dateValue.endsWith("Z") &&
      !dateValue.includes("+")
    ) {
      // Server responds with timezone naive strings, add Z to indicate UTC.
      // If the string somehow already contains a timezone offset, do not add Z.
      dateValue += "Z";
    }
    // Server has no timezone support, return date in ISO format
    return new Date(dateValue).toISOString();
  }

  /**
   * Decode datetime *data* into moment objects.
   *
   * Translate objects with __type__ equal to 'datetime' into moment
   * datetime objects. If time zone support is enabled on the server the date
   * will be assumed to be UTC and the moment will be in utc.
   * @private
   */
  private _decodeDateTimeAsMoment(data: any) {
    if (
      this.serverInformation &&
      this.serverInformation.is_timezone_support_enabled
    ) {
      // Return date as moment object with UTC set to true.
      return moment.utc(data.value);
    }

    // Return date as local moment object.
    return moment(data.value);
  }

  /**
   * Return new object where all values have been decoded.
   * @private
   */
  private _decodePlainObject(
    object: Data,
    identityMap: Data,
    {
      decodeDatesAsIso,
      ensureSerializableResponse,
    }: {
      decodeDatesAsIso?: boolean;
      ensureSerializableResponse?: boolean;
    } = {},
  ) {
    return Object.keys(object).reduce<Data>((previous, key) => {
      previous[key] = this.decode(object[key], identityMap, {
        decodeDatesAsIso,
        ensureSerializableResponse,
      });
      return previous;
    }, {});
  }

  /**
   * Return new Array where all items have been decoded.
   * @private
   */
  private _decodeArray(
    collection: any[],
    identityMap: Data,
    {
      decodeDatesAsIso = false,
      ensureSerializableResponse = false,
    }: {
      decodeDatesAsIso?: boolean;
      ensureSerializableResponse?: boolean;
    } = {},
  ): any[] {
    return collection.map((item) =>
      this.decode(item, identityMap, {
        decodeDatesAsIso,
        ensureSerializableResponse,
      }),
    );
  }

  /**
   * Return merged *entity* using *identityMap*.
   * @private
   */
  private _mergeEntity(
    entity: Data,
    identityMap: Data,
    {
      decodeDatesAsIso,
      ensureSerializableResponse,
    }: {
      decodeDatesAsIso?: boolean;
      ensureSerializableResponse?: boolean;
    } = {},
  ) {
    const identifier = this.getIdentifyingKey(entity);
    if (!identifier) {
      logger.warn("Identifier could not be determined for: ", identifier);
      return entity;
    }

    if (!identityMap[identifier]) {
      identityMap[identifier] = {};
    }

    // Retrieve entity from identity map. Any instances which occur multiple
    // times in the encoded data will point to the same JavaScript object.
    // This means that output is not guaranteed to be JSON-serializable.
    //
    // TODO: Should we duplicate the information between the instances
    // instead of pointing them to the same instance?
    const mergedEntity = identityMap[identifier];

    for (const key in entity) {
      if (entity.hasOwnProperty(key)) {
        mergedEntity[key] = this.decode(entity[key], identityMap, {
          decodeDatesAsIso,
          ensureSerializableResponse,
        });
      }
    }
    return mergedEntity;
  }

  /** Return encoded *operations*. */
  encodeOperations(operations: operation.Operation<keyof TEntityTypeMap>[]) {
    return JSON.stringify(this.encode(operations));
  }

  /**
   * Returns server information for the session, using serverInformationValues as set on session initialization.
   * This is cached after the first call, and assumes that the server information will not change during the session.
   * @returns Promise with the server information for the session.
   */
  async getServerInformation(): Promise<ServerInformation> {
    if (!this.serverInformationPromise) {
      this.serverInformationPromise = this.call<QueryServerInformationResponse>(
        [
          {
            action: "query_server_information",
            values: this.serverInformationValues,
          },
        ],
      ).then((responses) => responses[0]);
    }

    return this.serverInformationPromise;
  }

  /**
   * Returns server version for the session, using serverInformationValues as set on session initialization.
   * This is cached after the first call, and assumes that the server information will not change during the session.
   * @returns Promise with the server version for the session.
   */
  async getServerVersion(): Promise<string> {
    return (await this.getServerInformation()).version;
  }

  /**
   * Returns the API schemas for the session.
   * This is cached after the first call, and assumes that the schemas will not change during the session.
   * @returns Promise with the API schemas for the session.
   */
  async getSchemas(): Promise<Schema<TEntityTypeMap>[]> {
    if (!this.schemasPromise) {
      this.schemasPromise = this.call<QuerySchemasResponse<TEntityTypeMap>>([
        { action: "query_schemas" },
      ]).then((responses) => {
        this.schemaMapping = getSchemaMappingFromSchemas<
          TEntityTypeMap[keyof TEntityTypeMap]
        >(responses[0]);
        return responses[0];
      });
    }
    return this.schemasPromise;
  }

  /**
   * Call API with array of operation objects in *operations*.
   *
   * Returns promise which will be resolved with an array of decoded
   * responses.
   *
   * The return promise may be rejected with one of several errors:
   *
   * ServerValidationError
   *     Validation errors
   * ServerPermissionDeniedError
   *     Permission defined errors
   * ServerError
   *     Generic server errors or network issues
   *
   * @typeParam T - Either an array of response types to get return type `Tuple<T[0], ..., T[n]>`, or a single response type to get return type T[]. Default is ActionResponse.
   * @param {Array} operations - API operations.
   * @param {Object} options
   * @param {AbortController} options.abortController - Abort controller, deprecated in favor of options.signal
   * @param {AbortSignal} options.signal - Abort signal
   * @param {string} options.pushToken - push token to associate with the request
   * @param {object} options.headers - Additional headers to send with the request
   * @param {string} options.decodeDatesAsIso - Return dates as ISO strings instead of moment objects
   *
   */
  async call<T = ActionResponse<keyof TEntityTypeMap>>(
    operations: operation.Operation<keyof TEntityTypeMap>[],
    {
      abortController,
      pushToken,
      signal,
      additionalHeaders = {},
      decodeDatesAsIso = this.decodeDatesAsIso,
      ensureSerializableResponse = this.ensureSerializableResponse,
    }: CallOptions = {},
  ): Promise<IsTuple<T> extends true ? Partial<T> : Partial<T>[]> {
    if (this.initializing) {
      await this.initializing;
    }
    const url = `${this.serverUrl}${this.apiEndpoint}`;
    try {
      // Delay call until session is initialized if initialization is in
      // progress.
      let fetchResponse;
      try {
        fetchResponse = await fetch(url, {
          method: "post",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "ftrack-api-key": this.apiKey,
            "ftrack-user": this.apiUser,
            "ftrack-Clienttoken": this.clientToken,
            "ftrack-pushtoken": pushToken,
            ...(ensureSerializableResponse
              ? {
                  "ftrack-api-options": "strict:1;denormalize:1",
                }
              : {}),
            ...this.additionalHeaders,
            ...additionalHeaders,
          } as HeadersInit,
          body: this.encodeOperations(operations),
          signal: abortController ? abortController.signal : signal,
        });
      } catch (reason) {
        if (reason instanceof Error) {
          throw this.getErrorFromResponse({
            exception: "NetworkError",
            content: (reason["cause"] as string) || reason.message,
          });
        }
        throw new Error("Unknown error: " + JSON.stringify(reason));
      }

      const response = await fetchResponse.json();

      if (response.exception) {
        throw this.getErrorFromResponse(response);
      }
      try {
        return this.decode(
          response,
          {},
          { decodeDatesAsIso, ensureSerializableResponse },
        );
      } catch (reason) {
        logger.warn("Server reported error in unexpected format. ", reason);
        throw this.getErrorFromResponse({
          exception: "MalformedResponseError",
          content: "Response is malformed",
        });
      }
    } catch (reason) {
      logger.warn("Failed to perform request. ", reason);
      if (reason instanceof Error && reason.name === "AbortError") {
        throw this.getErrorFromResponse({
          exception: "AbortError",
          content: reason.message,
        });
      }
      throw reason;
    }
  }

  /**
   * Return promise of *entityType* with *data*, create or update if necessary.
   *
   *   *data* should be a dictionary of the same form passed to `create`
   *   method.
   *
   *   By default, check for an entity that has matching *data*. If
   *   *identifyingKeys* is specified as a list of keys then only consider the
   *   values from *data* for those keys when searching for existing entity.
   *
   *   If no *identifyingKeys* specified then use all of the keys from the
   *   passed *data*.
   *
   *   Raise an Error if no *identifyingKeys* can be determined.
   *
   *   If no matching entity found then create entity using supplied *data*.
   *
   *   If a matching entity is found, then update it if necessary with *data*.
   *
   *   Return update or create promise.
   */

  ensure<TEntityType extends keyof TEntityTypeMap>(
    entityType: TEntityType,
    data: TEntityTypeMap[TEntityType],
    identifyingKeys: Array<keyof TEntityTypeMap[TEntityType]> = [],
  ): Promise<Partial<TEntityTypeMap[TEntityType]>> {
    let keys = identifyingKeys as string[];

    const anyData = data as any;

    logger.info(
      "Ensuring entity with data using identifying keys: ",
      entityType,
      anyData,
      keys,
    );

    if (!keys.length) {
      keys = Object.keys(anyData);
    }

    if (!keys.length) {
      throw new Error(
        "Could not determine any identifying data to check against " +
          `when ensuring ${String(entityType)} with data ${anyData}. ` +
          `Identifying keys: ${identifyingKeys}`,
      );
    }

    const primaryKeys = this.getPrimaryKeyAttributes(entityType);
    if (primaryKeys === null || primaryKeys.length === 0) {
      throw new Error(
        `Primary key could not be found for: ${String(entityType)}`,
      );
    }
    let expression = `select ${primaryKeys.join(
      ", ",
    )} from ${String(entityType)} where`;
    const criteria = keys.map((identifyingKey) => {
      let value = anyData[identifyingKey];

      if (value != null && typeof value.valueOf() === "string") {
        value = `"${value}"`;
      } else if (convertToIsoString(value)) {
        value = convertToIsoString(value);
        value = `"${value}"`;
      }
      return `${identifyingKey} is ${value}`;
    });

    expression = `${expression} ${criteria.join(" and ")}`;

    return this.query<TEntityType>(expression).then((response) => {
      if (response.data.length === 0) {
        return this.create<TEntityType>(entityType, anyData).then(
          ({ data: responseData }) => Promise.resolve(responseData),
        );
      }

      if (response.data.length !== 1) {
        throw new Error(
          "Expected single or no item to be found but got multiple " +
            `when ensuring ${String(entityType)} with data ${anyData}. ` +
            `Identifying keys: ${identifyingKeys}`,
        );
      }

      const updateEntity = response.data[0] as any;

      // Update entity if required.
      let updated = false;
      Object.keys(anyData).forEach((key) => {
        if (anyData[key] !== updateEntity[key]) {
          updateEntity[key] = anyData[key];
          updated = true;
        }
      });

      if (updated) {
        return this.update<TEntityType>(
          entityType,
          primaryKeys.map((key: string) => updateEntity[key]),
          Object.keys(anyData).reduce<any>(
            (accumulator, key) => {
              if (primaryKeys.indexOf(key.toString()) === -1) {
                accumulator[key] = anyData[key];
              }
              return accumulator;
            },
            {} as TEntityTypeMap[TEntityType],
          ),
        ).then(({ data: responseData }) =>
          Promise.resolve(responseData as TEntityTypeMap[TEntityType]),
        );
      }

      return Promise.resolve(response.data[0]) as any;
    });
  }

  /**
   * Return schema with id or null if not existing.
   * @param  {string} schemaId Id of schema model, e.g. `AssetVersion`.
   * @return {Object|null} Schema definition
   */
  getSchema<TEntityType extends keyof TEntityTypeMap>(
    schemaId: TEntityType,
  ): Schema<TEntityTypeMap, TEntityType> | null {
    // TODO: make this async in next major
    const schema = this.schemaMapping?.[schemaId];
    return schema ?? null;
  }

  /**
   * Perform a single query operation with *expression*.
   *
   * @param {string} expression - API query expression.
   * @param {object} options
   * @param {object} options.abortController - Deprecated in favour of options.signal
   * @param {object} options.signal - Abort signal user for aborting requests prematurely
   * @param {object} options.headers - Additional headers to send with the request
   * @param {object} options.decodeDatesAsIso - Decode dates as ISO strings instead of moment objects
   * @param {object} options.ensureSerializableResponse - Disable normalization of response data
   * @return {Promise} Promise which will be resolved with an object
   * containing action, data and metadata
   */
  async query<TEntityType extends keyof TEntityTypeMap>(
    expression: string,
    options: QueryOptions = {},
  ) {
    logger.debug("Query", expression);
    const responses = await this.call<
      [QueryResponse<TEntityTypeMap[TEntityType]>]
    >([operation.query(expression)], options);
    return responses[0];
  }

  /**
   * Perform a single search operation with *expression*.
   *
   * @param {Object}   options
   * @param {String}   options.expression     API query expression
   * @param {String}   options.entityType     Entity type to search for
   * @param {String[]} options.terms          Search terms
   * @param {String}   [options.contextId]    Context id to limit the search result to
   * @param {String[]} [options.objectTypeIds] Object type ids to limit the search result to
   * @param {object} additionalOptions
   * @param {object} options.abortController - Deprecated in favour of options.signal
   * @param {object} options.signal - Abort signal user for aborting requests prematurely
   * @param {object} options.headers - Additional headers to send with the request
   * @param {object} options.decodeDatesAsIso - Decode dates as ISO strings instead of moment objects
   * @param {object} options.ensureSerializableResponse - Disable normalization of response data
   * @return {Promise} Promise which will be resolved with an object
   * containing data and metadata
   */
  async search<TEntityType extends keyof TEntityTypeMap>(
    {
      expression,
      entityType,
      terms = [],
      contextId,
      objectTypeIds,
    }: SearchOptions<TEntityType>,
    options: QueryOptions = {},
  ) {
    logger.debug("Search", {
      expression,
      entityType,
      terms,
      contextId,
      objectTypeIds,
    });

    const responses = await this.call<[SearchResponse<TEntityType>]>(
      [
        operation.search({
          expression,
          entityType,
          terms,
          contextId,
          objectTypeIds,
        }),
      ],
      options,
    );
    return responses[0];
  }

  /**
   * Perform a single create operation with *type* and *data*.
   *
   * @param {string} entityType entity type name.
   * @param {Object} data data which should be used to populate attributes on the entity.
   * @param {Object} options
   * @param {string} options.pushToken - push token to associate with the request
   * @param {object} options.headers - Additional headers to send with the request
   * @param {object} options.decodeDatesAsIso - Decode dates as ISO strings instead of moment objects
   * @param {object} options.ensureSerializableResponse - Disable normalization of response data
   * @return {Promise} Promise which will be resolved with the response.
   */
  async create<TEntityType extends keyof TEntityTypeMap>(
    entityType: TEntityType,
    data: Partial<TEntityTypeMap[TEntityType]>,
    options: MutationOptions = {},
  ) {
    logger.debug("Create", entityType, data, options);

    const responses = await this.call<
      [CreateResponse<TEntityTypeMap[TEntityType]>]
    >([operation.create(entityType, data)], options);
    return responses[0];
  }

  /**
   * Perform a single update operation on *type* with *keys* and *data*.
   *
   * @param  {string} type Entity type
   * @param  {Array} keys Identifying keys, typically [<entity id>]
   * @param  {Object} data
   * @param {Object} options
   * @param {string} options.pushToken - push token to associate with the request
   * @param {object} options.headers - Additional headers to send with the request
   * @param {object} options.decodeDatesAsIso - Decode dates as ISO strings instead of moment objects
   * @param {object} options.ensureSerializableResponse - Disable normalization of response data
   * @return {Promise} Promise resolved with the response.
   */
  async update<TEntityType extends keyof TEntityTypeMap>(
    type: TEntityType,
    keys: string[] | string,
    data: Partial<TEntityTypeMap[TEntityType]>,
    options: MutationOptions = {},
  ) {
    logger.debug("Update", type, keys, data, options);

    const responses = await this.call<
      [UpdateResponse<TEntityTypeMap[TEntityType]>]
    >([operation.update(type, keys, data)], options);
    return responses[0];
  }

  /**
   * Perform a single delete operation.
   *
   * @param  {string} type Entity type
   * @param  {Array} keys Identifying keys, typically [<entity id>]
   * @param {Object} options
   * @param {string} options.pushToken - push token to associate with the request
   * @param {object} options.headers - Additional headers to send with the request
   * @param {object} options.decodeDatesAsIso - Decode dates as ISO strings instead of moment objects
   * @return {Promise} Promise resolved with the response.
   */
  async delete<TEntityType extends keyof TEntityTypeMap>(
    type: TEntityType,
    keys: string[] | string,
    options: MutationOptions = {},
  ) {
    logger.debug("Delete", type, keys, options);

    const responses = await this.call<[DeleteResponse]>(
      [operation.delete(type, keys)],
      options,
    );

    return responses[0];
  }

  /**
   * Return an URL where *componentId* can be downloaded.
   *
   * @param {?string} componentId Is assumed to be present in the
   *                  ftrack.server location.
   * @return {String|null} URL where *componentId* can be downloaded, null
   *                       if component id is not specified.
   */
  getComponentUrl(componentId: string) {
    if (!componentId) {
      return null;
    }

    const params = {
      id: componentId,
      username: this.apiUser,
      apiKey: this.apiKey,
    };

    return `${this.serverUrl}/component/get?${new URLSearchParams(
      params,
    ).toString()}`;
  }

  /**
   * Return an URL where a thumbnail for *componentId* can be downloaded.
   *
   * @param {?string} componentId - Is assumed to be present in the
   *                  ftrack.server location and be of a valid image file type.
   * @param {?object} [options = {}] - Options
   * @param {?number} options.size - The size of the thumbnail. The image will be resized to
   *                  fit within size x size pixels. Defaults to 300.
   * @return {string} URL where *componentId* can be downloaded. Returns the
   *                  URL to a default thumbnail if component id is not
   *                  specified.
   */
  thumbnailUrl(componentId: string, { size = 300 } = {}) {
    if (!componentId) {
      return `${this.serverUrl}/img/thumbnail2.png`;
    }

    const params = {
      id: componentId,
      size: String(size),
      username: this.apiUser,
      apiKey: this.apiKey,
    };

    return `${this.serverUrl}/component/thumbnail?${new URLSearchParams(
      params,
    ).toString()}`;
  }

  /**
   * Create component from *file* and add to server location.
   *
   * @param  {Blob} - The file object to upload.
   * @param {?object} [options = {}] - Options
   * @param {?string} options.name - Component name. Defaults get from file object.
   * @param {?number} options.data - Component data. Defaults to {}.
   * @param {XMLHttpRequest} options.xhr - Custom XHR object, deprecated in favor of options.signal.
   * @param {AbortSignal} options.signal - Abort signal
   * @return {Promise} Promise resolved with the response when creating
   * Component and ComponentLocation.
   */
  async createComponent(
    file: Blob,
    options: CreateComponentOptions = {},
  ): Promise<
    readonly [
      CreateResponse<TEntityTypeMap["FileComponent"]>,
      CreateResponse<TEntityTypeMap["ComponentLocation"]>,
      GetUploadMetadataResponse,
    ]
  > {
    return new Promise((resolve, reject) => {
      const uploader = new Uploader<TEntityTypeMap>(this, file, {
        ...options,
        onError(error) {
          reject(error);
        },
        onComplete() {
          // TODO: Deprecate createComponent response.
          resolve([
            uploader.createComponentResponse!,
            uploader.createComponentLocationResponse!,
            uploader.uploadMetadata!,
          ]);
        },
      });

      uploader.start().catch(reject);
    });
  }
}

/**
 * Tagged string template for preparing statements to prevent injection attacks.
 */
export function expression(
  literals: TemplateStringsArray,
  ...placeholders: string[]
): string {
  let result = "";

  for (let i = 0; i < placeholders.length; i++) {
    result += literals[i];
    result += placeholders[i].replace(/(['"])/g, "\\$1");
  }

  result += literals[literals.length - 1];
  return result;
}
