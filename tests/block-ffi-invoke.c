/* Exercise the public Clang/Apple Blocks calling convention, not a Rust mock. */
int invoke_int_block(int (^callback)(int), int value) {
    return callback(value);
}
