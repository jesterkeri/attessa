"""Apply one adversary mutation to a scratch copy of contracts/ (argv[2]). Line-exact replacements."""
import json, sys, pathlib

mut, w = sys.argv[1], pathlib.Path(sys.argv[2])
src = w / "src" / "EnclaveRegistry.sol"
text = src.read_text()

KILL = """
    function advKill() external {
        selfdestruct(payable(msg.sender));
    }

    function advSweep(address payable to) external {
        to.transfer(address(this).balance);
    }
"""
STANDALONE = """// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract AdvKillable {
    function advKill() external {
        selfdestruct(payable(msg.sender));
    }

    function advSweep(address payable to) external {
        to.transfer(address(this).balance);
    }
}
"""


def replace_once(t, old, new):
    assert t.count(old) == 1, old
    return t.replace(old, new)


if mut == "nofilter":
    cfg = json.loads((w / "slither.config.json").read_text())
    cfg.pop("filter_paths", None)
    cfg.pop("include_paths", None)
    (w / "slither.config.json").write_text(json.dumps(cfg))
elif mut in ("high", "highnodeps"):
    if mut == "highnodeps":
        # Attribution run: same as high, with exclude_dependencies off.
        cfg = json.loads((w / "slither.config.json").read_text())
        cfg["exclude_dependencies"] = False
        (w / "slither.config.json").write_text(json.dumps(cfg))
    # Append after the last function so no existing finding's line numbers move.
    i = text.rstrip().rfind("}")
    text = text[:i] + KILL + text[i:]
elif mut == "sameline":
    # Remove the length guards the triage relies on, keeping every line number.
    text = replace_once(
        text,
        "if (!_validPcr(pcr0) || !_validPcr(pcr1) || !_validPcr(pcr2)) revert InvalidPcr();",
        "if (_allZero(pcr0) || _allZero(pcr1) || _allZero(pcr2)) revert InvalidPcr();",
    )
    text = replace_once(
        text,
        "if (ptr.isNull() || ptr.length() != PCR_LENGTH) revert InvalidPcr();",
        "if (ptr.isNull()) revert InvalidPcr();",
    )
elif mut == "pathname":
    (w / "src" / "Transcript.sol").write_text(STANDALONE)
elif mut == "control":
    (w / "src" / "Sweeper.sol").write_text(STANDALONE)
elif mut == "libhigh":
    # A High (reentrancy-eth) whose elements span src/ and lib/: the state variable written after
    # the ETH call is CertManager.owner, declared in lib/nitro-validator.
    (w / "src" / "AdvReent.sol").write_text("""// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CertManager} from "nitro-validator/CertManager.sol";
import {IP384Verifier} from "nitro-validator/IP384Verifier.sol";

contract AdvReent is CertManager {
    constructor() CertManager(IP384Verifier(address(1)), msg.sender, msg.sender) {}

    function advPay() external {
        (bool ok,) = msg.sender.call{value: 1}("");
        require(ok);
        owner = msg.sender;
    }
}
""")
elif mut == "outside":
    # Deployed code that lives outside contracts/src/ and outside lib/: src/AdvUser.sol inherits an
    # unprotected selfdestruct from contracts/shared/AdvKillable.sol.
    (w / "shared").mkdir()
    (w / "shared" / "AdvKillable.sol").write_text(STANDALONE)
    (w / "src" / "AdvUser.sol").write_text("""// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AdvKillable} from "../shared/AdvKillable.sol";

contract AdvUser is AdvKillable {}
""")
elif mut == "srclib":
    # A src subdirectory named "lib": crytic-compile marks any path with a "lib" part as a
    # dependency, and exclude_dependencies drops it even though include_paths matches.
    (w / "src" / "lib").mkdir()
    (w / "src" / "lib" / "AdvKillable.sol").write_text(STANDALONE)
elif mut in ("deployedlib", "deployedlibgated"):
    # Bring the rest of the deployed validator stack (SPEC 3.5: P384Verifier, CertManager) into the
    # compile unit; src/ alone only reaches NitroValidator and its libraries.
    (w / "src" / "AdvStack.sol").write_text("""// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CertManager} from "nitro-validator/CertManager.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
""")
    if mut == "deployedlib":
        cfg = json.loads((w / "slither.config.json").read_text())
        cfg.pop("include_paths", None)
        cfg.pop("filter_paths", None)
        (w / "slither.config.json").write_text(json.dumps(cfg))
elif mut == "symlink":
    # src/AdvLink.sol is a symlink to a file outside contracts/; Slither resolves symlinks before
    # matching include_paths.
    outside = w.parent / "elsewhere"
    outside.mkdir()
    (outside / "AdvKillable.sol").write_text(STANDALONE)
    (w / "src" / "AdvLink.sol").symlink_to(outside / "AdvKillable.sol")
elif mut == "inlinecomment":
    # The high mutant, each new function preceded by an inline Slither ignore comment.
    i = text.rstrip().rfind("}")
    text = text[:i] + KILL.replace("    function adv", "    // slither-disable-next-line all\n    function adv") + text[i:]
elif mut in ("outsiderepo", "outsiderepoallow"):
    # Deployed code outside contracts/: src/AdvUser.sol inherits a selfdestruct from ../shared/
    # (a sibling of contracts/ in the repo). The allow variant adds foundry's allow_paths for it.
    (w.parent / "shared").mkdir()
    (w.parent / "shared" / "AdvKillable.sol").write_text(STANDALONE)
    (w / "src" / "AdvUser.sol").write_text("""// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AdvKillable} from "../../shared/AdvKillable.sol";

contract AdvUser is AdvKillable {}
""")
    if mut == "outsiderepoallow":
        f = w / "foundry.toml"
        f.write_text(f.read_text().replace("[profile.default]\n", "[profile.default]\nallow_paths = [\"../shared\"]\n", 1))
elif mut == "clean":
    pass
else:
    sys.exit(f"unknown mutant {mut}")
src.write_text(text)
print(f"applied {mut}")
