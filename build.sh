echo Cleaning previous build ... && \
rm -rf *.node && \
echo Start building ... && \
ZIG_GLOBAL_CACHE_DIR=/tmp/empty_cache ZIG_LOCAL_CACHE_DIR=/tmp/empty_cache  zig cc hello.c -I./node-api-headers/include -shared -o hello.node -Xlinker --allow-shlib-undefined
echo Build finished.
echo Test ...
node index.js

# g++ -shared -std=c++17  -I node-api-headers/include -o hello.node hello.cc -L . -lnode_api
# zig c++ -shared -std=c++17  -I node-api-headers/include -o hello.node hello.cc -L . -lnode_api 