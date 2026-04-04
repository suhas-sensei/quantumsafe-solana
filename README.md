# PORST demo

https://eprint.iacr.org/2017/933.pdf

PORST is a few-time signature scheme related to HORST and FORS used in SPHINCS
and SPHINCS+, respectively. While FORS has desirable qualities in the
completely-stateless setting, in the EVM setting, complete statelessness is not
required. Infrequent state synchronization is expected in order to obtain the
state of the world. Therefore, we can exploit PORST's smaller average witnesses
in combination with the typical XMSS technique to obtain a more gas-efficient
post-quantum signature and wallet.

This repository only presents the PORST portion of the above technique. Wrapping
this into a complete post-quantum signing product is straightforward, but is
beyond the author's capacity to complete solo in a single hackathon.
