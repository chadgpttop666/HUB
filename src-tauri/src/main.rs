// Без этой строки Windows открывает вместе с хабом окно консоли (в отладочной сборке консоль оставлена для логов).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hub_lib::run()
}
