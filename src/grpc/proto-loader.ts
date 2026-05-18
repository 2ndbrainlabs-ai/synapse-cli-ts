import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached: any = null;

export function loadProto(): any {
  if (cached) return cached;

  const grpc = require("@grpc/grpc-js");
  const protoLoader = require("@grpc/proto-loader");

  // Proto file ships with the package — try bundled path first, then source layout
  let PROTO_PATH = path.resolve(__dirname, "../protos/synapse.proto");
  if (!require("fs").existsSync(PROTO_PATH)) {
    PROTO_PATH = path.resolve(__dirname, "../../protos/synapse.proto");
  }

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(packageDef);
  cached = proto.synapse;
  return cached;
}
