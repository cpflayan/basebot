#!/bin/bash
set -e

RPC="http://127.0.0.1:8545"
KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
MORPHO="0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
WETH="0x4200000000000000000000000000000000000006"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
ORACLE="0xFEa2D58cEfCb9fcb597723c6bAE66fFFE4193aFE4"
IRM="0x46415998764C29aB2a25CbeA6254146D50D22687"
LLTV="860000000000000000"

echo "=== Step 1: wETH balance ==="
cast call $WETH "balanceOf(address)(uint256)" $ADDR --rpc-url $RPC

echo "=== Step 2: Supply 1 wETH as collateral ==="
cast send $MORPHO \
  "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)" \
  "($WETH,$USDC,$ORACLE,$IRM,$LLTV)" \
  1000000000000000000 \
  $ADDR \
  "0x" \
  --rpc-url $RPC --private-key $KEY

echo "=== Step 3: Verify position ==="
MARKET_ID="0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda"
cast call $MORPHO "position(bytes32,address)(uint256,uint128,uint128)" $MARKET_ID $ADDR --rpc-url $RPC

echo "=== Step 4: Borrow some USDC ==="
# First approve Morpho to spend USDC (for repay later)
# Borrow 500 USDC (6 decimals)
cast send $MORPHO \
  "borrow((address,address,address,address,uint256),uint256,uint256,address,address)" \
  "($WETH,$USDC,$ORACLE,$IRM,$LLTV)" \
  500000000 \
  0 \
  $ADDR \
  $ADDR \
  --rpc-url $RPC --private-key $KEY

echo "=== Step 5: Verify position after borrow ==="
cast call $MORPHO "position(bytes32,address)(uint256,uint128,uint128)" $MARKET_ID $ADDR --rpc-url $RPC

echo "=== Step 6: Check Oracle price ==="
cast call $ORACLE "price()(uint256)" --rpc-url $RPC

echo "=== Step 7: Time travel 1 hour ==="
cast rpc evm_increaseTime 3600 --rpc-url $RPC
cast rpc evm_mine --rpc-url $RPC

echo "=== Done ==="
