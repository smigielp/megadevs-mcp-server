#!/bin/bash

BASE_URL="http://localhost:3000"
AUTH_TOKEN="1b5fcb2fdcd1b79915794ed79b3557f43728972bcb69989c5d04d3c040951bcf"

echo "=== Testing MCP Server ==="
echo ""

# Test 1: Initialize
echo "1. Testing initialize method..."
curl -s -X POST $BASE_URL/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }' | jq .
echo ""

# Test 2: List tools
echo "2. Testing tools/list..."
curl -s -X POST $BASE_URL/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }' | jq .
echo ""

# Test 3: memo_write
echo "3. Testing memo_write..."
curl -s -X POST $BASE_URL/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "memo_write",
      "arguments": {
        "text": "Testing MCP server - automated test memo"
      }
    }
  }' | jq .
echo ""

# Test 4: memo_search
echo "4. Testing memo_search..."
curl -s -X POST $BASE_URL/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "memo_search",
      "arguments": {
        "query": "test"
      }
    }
  }' | jq .
echo ""

# Test 5: List resources
echo "5. Testing resources/list..."
curl -s -X POST $BASE_URL/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "resources/list",
    "params": {}
  }' | jq .
echo ""

echo "=== Tests Complete ==="
