import { arbitrum, base, katana, mainnet, unichain, worldchain } from "viem/chains";
import { hyperevm, monad } from "../chains";
export const wrappers = {
    [mainnet.id]: {},
    [base.id]: {},
    [arbitrum.id]: {},
    [katana.id]: {},
    [monad.id]: {},
    [unichain.id]: {},
    [worldchain.id]: {},
    [hyperevm.id]: {},
};
