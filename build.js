'use strict'

const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { def_paths } = require('node-api-headers')
const { writeFile } = require('fs').promises

async function main() {
    await exec(` dlltool -d ${def_paths.node_api_def} -y libnode_api.a`)
}
main().catch(err => console.error(err))