import { z as _z } from "zod";
import {
  createSchema,
  collection,
  makeCollection,
  blob,
  type Schema as _Schema,
  type SchemaShape as _SchemaShape,
  type InferSchema as _InferSchema,
  type InferRoot as _InferRoot,
  type InferSchemaRoot as _InferSchemaRoot,
  type CollectionRefBrand as _CollectionRefBrand,
  type CollectionRefValue as _CollectionRefValue,
} from "@zenbu/kyju/schema";
import {
  connectReplica as _connectReplica,
  dbStringify,
  dbParse,
} from "@zenbu/kyju/transport";
import type {
  ClientProxy as _ClientProxy,
  CollectionNode as _CollectionNode,
} from "@zenbu/kyju";

export { createSchema, collection, makeCollection, blob, dbStringify, dbParse };
export const z = _z;

export type Schema<TShape extends _SchemaShape = _SchemaShape> =
  _Schema<TShape>;
export type SchemaShape = _SchemaShape;
export type InferSchema<S extends _Schema> = _InferSchema<S>;
export type InferRoot<T extends _SchemaShape> = _InferRoot<T>;
export type InferSchemaRoot<S> = _InferSchemaRoot<S>;
export type CollectionRefBrand<T = unknown> = _CollectionRefBrand<T>;
export type CollectionRefValue<T = unknown> = _CollectionRefValue<T>;
export type CollectionNode<T = unknown> = _CollectionNode<T>;
export type DbClient<T extends _SchemaShape = _SchemaShape> = _ClientProxy<T>;

export const connectDb: typeof _connectReplica = _connectReplica;
