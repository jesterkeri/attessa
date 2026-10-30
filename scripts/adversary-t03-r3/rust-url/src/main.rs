// Third opinion: rust-url (WHATWG, idna UTS-46 non-transitional) on each stdin line.
use std::io::BufRead;
fn main() {
    for line in std::io::stdin().lock().lines() {
        let l = line.unwrap();
        match url::Url::parse(&l) {
            Ok(u) => println!("ok\t{}\t{}\t{}", u.host_str().unwrap_or(""), u.username(), u.password().unwrap_or("<none>")),
            Err(e) => println!("err\t{}", e),
        }
    }
}
