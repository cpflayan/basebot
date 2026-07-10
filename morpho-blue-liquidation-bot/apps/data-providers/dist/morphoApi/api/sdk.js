import gql from "graphql-tag";
export const GetLiquidatablePositionsDocument = gql `
  query getLiquidatablePositions(
    $chainId: Int!
    $marketIds: [String!]
    $skip: Int
    $first: Int = 100
    $orderBy: MarketPositionOrderBy
    $orderDirection: OrderDirection
  ) {
    marketPositions(
      skip: $skip
      first: $first
      where: { chainId_in: [$chainId], marketUniqueKey_in: $marketIds, healthFactor_lte: 1 }
      orderBy: $orderBy
      orderDirection: $orderDirection
    ) {
      pageInfo {
        count
        countTotal
        limit
        skip
      }
      items {
        healthFactor
        user {
          address
        }
        market {
          uniqueKey: marketId
          oracle {
            address
          }
        }
        state {
          borrowShares
          collateral
          supplyShares
        }
      }
    }
  }
`;
const defaultWrapper = (action, _operationName, _operationType, _variables) => action();
export function getSdk(client, withWrapper = defaultWrapper) {
    return {
        getLiquidatablePositions(variables, requestHeaders, signal) {
            return withWrapper((wrappedRequestHeaders) => client.request({
                document: GetLiquidatablePositionsDocument,
                variables,
                requestHeaders: { ...requestHeaders, ...wrappedRequestHeaders },
                signal,
            }), "getLiquidatablePositions", "query", variables);
        },
    };
}
