echo Cleaning previous build ... && \
rm -rf *.node && \
echo Start building ... && \
ZIG_GLOBAL_CACHE_DIR=/tmp/empty_cache ZIG_LOCAL_CACHE_DIR=/tmp/empty_cache  zig cc hello.c -I./node-api-headers/include -shared -o hello.node -Xlinker --allow-shlib-undefined
echo Build finished.
echo Test ...
node index.js

# g++ -shared -std=c++17  -I node-api-headers/include -o hello.node hello.cc -L . -lnode_api
# zig c++ -shared -std=c++17  -I node-api-headers/include -o hello.node hello.cc -L . -lnode_api 


g++ -shared -std=c++17 \
  -I node-api-headers/include \
  -undefined dynamic_lookup \
  -o hello.node hello.cc

zig c++ -std=c++17 -shared \
  -I node-api-headers/include \
  -undefined dynamic_lookup \
  -o hello.node hello.cc

zig c++ -target x86_64-linux-gnu -std=c++17 -shared \
  -I node-api-headers/include \
  -o hello.node hello.cc

zig c++ -target x86_64-windows-gnu -std=c++17 -shared \
  -I node-api-headers/include \
  -Wl,--allow-shlib-undefined \
  -o hello.node hello.cc

zig dlltool -d ./node-api-headers/def/node_api.def -l node_api.a

zig c++ -std=c++17 -shared  -target x86_64-windows-gnu -I node-api-headers/include hello.cc node_api.a  -o hello.node

node -e "console.log(require('./hello.node').hello())"
