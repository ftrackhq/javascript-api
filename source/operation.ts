// :copyright: Copyright (c) 2016 ftrack
/**
 * Operations module
 * @namespace operation
 */

import type { DefaultEntityTypeMap, EntityType } from "./types.js";

export interface CreateOperation<TEntityTypeMap = DefaultEntityTypeMap> {
  action: "create";
  entity_type: EntityType<TEntityTypeMap>;
  entity_data: any;
}

export interface QueryOperation {
  action: "query";
  expression: string;
}

export interface SearchOperationOptions<TEntityTypeMap = DefaultEntityTypeMap> {
  expression?: string;
  entityType?: EntityType<TEntityTypeMap>;
  terms?: string[];
  contextId?: string;
  objectTypeIds?: string[];
}

export interface SearchOperation<TEntityTypeMap = DefaultEntityTypeMap> {
  action: "search";
  expression?: string;
  entity_type?: EntityType<TEntityTypeMap>;
  terms?: string[];
  context_id?: string;
  object_type_ids?: string[];
}

export interface UpdateOperation<TEntityTypeMap = DefaultEntityTypeMap> {
  action: "update";
  entity_type: EntityType<TEntityTypeMap>;
  entity_key: string[] | string;
  entity_data: any;
}

export interface DeleteOperation<TEntityTypeMap = DefaultEntityTypeMap> {
  action: "delete";
  entity_type: EntityType<TEntityTypeMap>;
  entity_key: string[] | string;
}

export interface QueryServerInformationOperation {
  action: "query_server_information";
  values?: string[];
}

export interface QuerySchemasOperation {
  action: "query_schemas";
}

export interface GetUploadMetadataOperation {
  action: "get_upload_metadata";
  file_name: string;
  file_size: number;
  component_id: string;
}

export type Operation<TEntityTypeMap = DefaultEntityTypeMap> =
  | CreateOperation<TEntityTypeMap>
  | QueryOperation
  | SearchOperation<TEntityTypeMap>
  | UpdateOperation<TEntityTypeMap>
  | DeleteOperation<TEntityTypeMap>
  | QueryServerInformationOperation
  | QuerySchemasOperation
  | GetUploadMetadataOperation
  | { action: string; [key: string]: any };

/**
 * Return create operation object for entity *type* and *data*.
 *
 * @function operation.create
 * @memberof operation
 * @param  {string} type Entity type
 * @param  {Object} data Entity data to use for creation
 * @return {Object}      API operation
 */
export function create(type: EntityType, data: any): CreateOperation {
  return {
    action: "create",
    entity_type: type,
    entity_data: { ...data, __entity_type__: type },
  };
}

/**
 * Return query operation object for *expression*.
 *
 * @function operation.query
 * @memberof operation
 * @param  {string} expression API query expression
 * @return {Object}            API operation
 */
export function query(expression: string): QueryOperation {
  return { action: "query", expression };
}

/**
 * Return search operation object for *expression*.
 *
 * @function operation.query
 * @memberof operation
 * @param  {string} expression API query expression
 * @return {Object}            API operation
 */
export function search({
  expression,
  entityType,
  terms,
  contextId,
  objectTypeIds,
}: SearchOperationOptions): SearchOperation {
  return {
    action: "search",
    expression,
    entity_type: entityType,
    terms,
    context_id: contextId,
    object_type_ids: objectTypeIds,
  };
}

/**
 * Return update operation object for entity *type* identified by *keys*.
 *
 * @function operation.update
 * @memberof operation
 * @param  {string} type Entity type
 * @param  {Array} keys Identifying keys, typically [<entity id>]
 * @param  {Object} data values to update
 * @return {Object}      API operation
 */
export function update(
  type: EntityType,
  keys: string[] | string,
  data: any,
): UpdateOperation {
  return {
    action: "update",
    entity_type: type,
    entity_key: keys,
    entity_data: { ...data, __entity_type__: type },
  };
}

/**
 * Return delete operation object for entity *type* identified by *keys*.
 *
 * @function operation.delete
 * @memberof operation
 * @param  {string} type Entity type
 * @param  {Array} keys Identifying keys, typically [<entity id>]
 * @return {Object}      API operation
 */
function deleteOperation(
  type: EntityType,
  keys: string[] | string,
): DeleteOperation {
  return {
    action: "delete",
    entity_type: type,
    entity_key: keys,
  };
}

export { deleteOperation as delete };
