import { GraphQLClient, RequestOptions } from "graphql-request";
import * as Types from "./types.js";
type GraphQLClientRequestHeaders = RequestOptions["requestHeaders"];
export declare const GetLiquidatablePositionsDocument: import("graphql").DocumentNode;
export type SdkFunctionWrapper = <T>(action: (requestHeaders?: Record<string, string>) => Promise<T>, operationName: string, operationType?: string, variables?: any) => Promise<T>;
export declare function getSdk(client: GraphQLClient, withWrapper?: SdkFunctionWrapper): {
    getLiquidatablePositions(variables: Types.GetLiquidatablePositionsQueryVariables, requestHeaders?: GraphQLClientRequestHeaders, signal?: RequestInit["signal"]): Promise<Types.GetLiquidatablePositionsQuery>;
};
export type Sdk = ReturnType<typeof getSdk>;
export {};
