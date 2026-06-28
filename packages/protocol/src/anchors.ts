// packages/protocol/src/anchors.ts
// Auto-generated public anchor registry. Contains code hashes only, never secret codes.
import type { Address, AnchorCodeCommitment, AnchorGenesisOwnership } from "./types";
import {
  ANCHOR_CLASSES, type AnchorClass, PROTOCOL, TOTAL_ANCHOR_SEATS,
  anchorPositionAllocationUZIR, ANCHOR_POSITION_ZIR_1X,
} from "./constants";

export const DEFAULT_ANCHOR_CODE_COMMITMENTS = [
  {
    "seatId": "A-001",
    "classCode": "A",
    "seatIndex": 1,
    "codeHash": "9fa1d2bb5334b8821489ce69343f1c961c9dd9836f8d5d9c61647a59527377d5"
  },
  {
    "seatId": "A-002",
    "classCode": "A",
    "seatIndex": 2,
    "codeHash": "1e0bc81aa838706589dae086badc2884b61e8a9c298552f08f191bd55453489e"
  },
  {
    "seatId": "A-003",
    "classCode": "A",
    "seatIndex": 3,
    "codeHash": "ae3aebb63cc15b7090c29dcf82374ce39f1f5c13f7e7e3af44c3b3e49b031ed9"
  },
  {
    "seatId": "A-004",
    "classCode": "A",
    "seatIndex": 4,
    "codeHash": "d87a88d9ea7ec098cc9d241917b1d708a762da9fb1b043ca56add5033c4d1627"
  },
  {
    "seatId": "A-005",
    "classCode": "A",
    "seatIndex": 5,
    "codeHash": "c35de6e28c042c0211fe53244f0c6829b4c521e3b9d271aaafa3c1f6c4e22095"
  },
  {
    "seatId": "A-006",
    "classCode": "A",
    "seatIndex": 6,
    "codeHash": "549675a2e5b520e2db2a0b7266276a250a822e0df74ab2b62c8a5c776a63f637"
  },
  {
    "seatId": "A-007",
    "classCode": "A",
    "seatIndex": 7,
    "codeHash": "9eb13d82bf89bb46c55964a6b2a7faeba5a2ca269a9a56fab7b65b1ad5f3a41a"
  },
  {
    "seatId": "A-008",
    "classCode": "A",
    "seatIndex": 8,
    "codeHash": "92a11788ec185d622830febee979d7e2cba4a54d9195e98e35c7acb46c9e8a05"
  },
  {
    "seatId": "A-009",
    "classCode": "A",
    "seatIndex": 9,
    "codeHash": "3bc3f97f3a2b8785991d914693147fbcd0c956a90f2028ea4a5d1d21e257f1d3"
  },
  {
    "seatId": "A-010",
    "classCode": "A",
    "seatIndex": 10,
    "codeHash": "3d82882faa5bd5eef73309968c8459379296185e3e6c4565afbdd31055988ed6"
  },
  {
    "seatId": "A-011",
    "classCode": "A",
    "seatIndex": 11,
    "codeHash": "e6bcfa62d95ffefeb05f2f82aadcda0ac6d7aa0291ba02f726fd03c8818c0865"
  },
  {
    "seatId": "A-012",
    "classCode": "A",
    "seatIndex": 12,
    "codeHash": "566ef6b9bcb3b999ee3ba02de3ad4a1b76342e2c3d674cbeb9b3d3e4ac21a21e"
  },
  {
    "seatId": "A-013",
    "classCode": "A",
    "seatIndex": 13,
    "codeHash": "36d9f53833f6bb2424304803530c1cd4d455c48640a45e3abf64fd5baf897cc5"
  },
  {
    "seatId": "A-014",
    "classCode": "A",
    "seatIndex": 14,
    "codeHash": "202e0aa2cccb351e5a13728524277a349e57a482446a575d177e1d805fa6af92"
  },
  {
    "seatId": "A-015",
    "classCode": "A",
    "seatIndex": 15,
    "codeHash": "ca2345ef8643f9a20b36182ca6b476bb83e7724e12d81f4987b80c2c5663e151"
  },
  {
    "seatId": "A-016",
    "classCode": "A",
    "seatIndex": 16,
    "codeHash": "fe5f0b06c2cc1954340524719a33e67f2972fa15bb8662f0d68ee637346a4de7"
  },
  {
    "seatId": "B-001",
    "classCode": "B",
    "seatIndex": 1,
    "codeHash": "dd7f25e34296a47bc78dfbf6994d62943c3efa6c4446e4be9afb5386b1245e1d"
  },
  {
    "seatId": "B-002",
    "classCode": "B",
    "seatIndex": 2,
    "codeHash": "afcf3d6f8445d7eece403c18b7250a4b9804320c407978fdfc7531aea4c23544"
  },
  {
    "seatId": "B-003",
    "classCode": "B",
    "seatIndex": 3,
    "codeHash": "02141d039e2510825dd5e0cfa35aae5f1b5c98946a5ca03e75890018e4e66e44"
  },
  {
    "seatId": "B-004",
    "classCode": "B",
    "seatIndex": 4,
    "codeHash": "86ada84a6df1753d56550c9b35794b389f3b9e0b76b64c7ffefb5e88f124e67c"
  },
  {
    "seatId": "B-005",
    "classCode": "B",
    "seatIndex": 5,
    "codeHash": "fcb9d824cef3d6b72b86e168f2389f0290a99a4868500ca84dd9a7cd5696443e"
  },
  {
    "seatId": "B-006",
    "classCode": "B",
    "seatIndex": 6,
    "codeHash": "76c724f130aa665e87edafd04635bf9dcd2e993fede1658ac8a5f3988937ea0c"
  },
  {
    "seatId": "B-007",
    "classCode": "B",
    "seatIndex": 7,
    "codeHash": "4d57ccd03af8aea7daf99e48058ad60cca9f80e349a65f4fd674a80a8b6f47ac"
  },
  {
    "seatId": "B-008",
    "classCode": "B",
    "seatIndex": 8,
    "codeHash": "fff0e9ea69fe7e5d693ac05021b2e131a3ecc748494e62837a770e15cc3fc922"
  },
  {
    "seatId": "B-009",
    "classCode": "B",
    "seatIndex": 9,
    "codeHash": "6c091354dc1966dc99810aa7117889a61ba9abb92ae1b998133afc41903643ab"
  },
  {
    "seatId": "B-010",
    "classCode": "B",
    "seatIndex": 10,
    "codeHash": "acb3a43b0f779254d837b4048ed8af5185bcd2f2d55641142bc9dbf8c8d9bd0c"
  },
  {
    "seatId": "B-011",
    "classCode": "B",
    "seatIndex": 11,
    "codeHash": "e8a16daca005ebb33fcdc0f430240a1f8ce2407b13c07776c600ba959f2c3b48"
  },
  {
    "seatId": "B-012",
    "classCode": "B",
    "seatIndex": 12,
    "codeHash": "0cf8c188891e5a5915e121b0140576a45b10cad87148fdc1e7655b556ca9c43a"
  },
  {
    "seatId": "B-013",
    "classCode": "B",
    "seatIndex": 13,
    "codeHash": "7ffbcf4983121dc91aadf68b28c238df05bfc3f99f768e59a6c8f082e011f76a"
  },
  {
    "seatId": "B-014",
    "classCode": "B",
    "seatIndex": 14,
    "codeHash": "3637a8711d12d2da7f347d472ea5722f10f0210b6d2d721159a3d961cc740eee"
  },
  {
    "seatId": "B-015",
    "classCode": "B",
    "seatIndex": 15,
    "codeHash": "69f9aa53226c595f14345fc900dcc7ff4baf8300af6d3c5affa779629613e2a7"
  },
  {
    "seatId": "B-016",
    "classCode": "B",
    "seatIndex": 16,
    "codeHash": "5d5fddfa3bd9be3a3caf1435d93178742f0f184c6935824a04d925a785f0e302"
  },
  {
    "seatId": "B-017",
    "classCode": "B",
    "seatIndex": 17,
    "codeHash": "866e6c5ae1beec06ba91ef6e6d7eb7617160c0f31fe1663b96b5f90c579fea07"
  },
  {
    "seatId": "B-018",
    "classCode": "B",
    "seatIndex": 18,
    "codeHash": "0994a3173df28fd8cc62d2f4ec50974d784aeb3c542f7e72a567590dba3ee51f"
  },
  {
    "seatId": "B-019",
    "classCode": "B",
    "seatIndex": 19,
    "codeHash": "6a1ad6fc6e1e1e20979b0415f408261d4187303e3738e4aea4cdfffac2d5a5b3"
  },
  {
    "seatId": "B-020",
    "classCode": "B",
    "seatIndex": 20,
    "codeHash": "a3440644679c589209328cc80f40f157d2f96db06e7c8823e60f16ba924ad0f5"
  },
  {
    "seatId": "B-021",
    "classCode": "B",
    "seatIndex": 21,
    "codeHash": "4ebbbea670393656781d1569d78f74c978898bca4dcfb5188f85314393eb62a6"
  },
  {
    "seatId": "B-022",
    "classCode": "B",
    "seatIndex": 22,
    "codeHash": "159e12589003466708137260050665e3e95a94989ae97a07c9622549cc9746bb"
  },
  {
    "seatId": "B-023",
    "classCode": "B",
    "seatIndex": 23,
    "codeHash": "d7a154f8519430871fe8ff70ca3a99cf2a95d2533036bc0e2f6662ebef14e873"
  },
  {
    "seatId": "B-024",
    "classCode": "B",
    "seatIndex": 24,
    "codeHash": "ea701da46a8d669c486d3a2ccc7534d8cc964f1c61ffae4f3429d34e8dae3471"
  },
  {
    "seatId": "B-025",
    "classCode": "B",
    "seatIndex": 25,
    "codeHash": "3186f64fc1f393aafb9311056cadd2ce7349989951bedf7e875853ae3a47d322"
  },
  {
    "seatId": "B-026",
    "classCode": "B",
    "seatIndex": 26,
    "codeHash": "d1f3155b7696fcd24d4519957aa48c918bf8b5b157e01b59e5e97c159d9d435e"
  },
  {
    "seatId": "B-027",
    "classCode": "B",
    "seatIndex": 27,
    "codeHash": "d6e6333fcf21aca582b62a9119f38ac5036e7e522fbea31e02285fb8d2b1b57f"
  },
  {
    "seatId": "B-028",
    "classCode": "B",
    "seatIndex": 28,
    "codeHash": "b311fab32d2acf1ef45b36e7af7f5caa0d39b8ac144b4d2a586fda1fdd372000"
  },
  {
    "seatId": "B-029",
    "classCode": "B",
    "seatIndex": 29,
    "codeHash": "ce6d3883b8555c0d92bcce3fa7fa8bcce4ffaf35800637d7ea8eb6a07f765a6f"
  },
  {
    "seatId": "B-030",
    "classCode": "B",
    "seatIndex": 30,
    "codeHash": "0918d57e21b497aad46fcd6b11391f12b0e1691a5036f05930a31ee673664474"
  },
  {
    "seatId": "B-031",
    "classCode": "B",
    "seatIndex": 31,
    "codeHash": "a5915fe36711568a855bb85e5e7be639aa8fc2096e027fbf1d0719b36e3a2797"
  },
  {
    "seatId": "B-032",
    "classCode": "B",
    "seatIndex": 32,
    "codeHash": "48d94d7816a7bb3767383dcb9f8f7357b62687ae6925e72a323c4cbcd9b19214"
  },
  {
    "seatId": "C-001",
    "classCode": "C",
    "seatIndex": 1,
    "codeHash": "2f978fa048fc0a0f3af9cd9e966033412fcaa06e1d8fa58184281fa0eba062d3"
  },
  {
    "seatId": "C-002",
    "classCode": "C",
    "seatIndex": 2,
    "codeHash": "9e74b270312151e27f126e1e5860f078557455ca57fb878b8a38acfc0cb417a5"
  },
  {
    "seatId": "C-003",
    "classCode": "C",
    "seatIndex": 3,
    "codeHash": "3b5fddd838f1c8ced12346f8ba072c0c199e975521438764d2f73fa003fe82d7"
  },
  {
    "seatId": "C-004",
    "classCode": "C",
    "seatIndex": 4,
    "codeHash": "dc550f7cd2947f89f2df114f19c6c78f4c532d943d2d0cdf070c46b1665aec75"
  },
  {
    "seatId": "C-005",
    "classCode": "C",
    "seatIndex": 5,
    "codeHash": "379f552f0bd6c03cb89083f2d3fcb40f6ddc8acf47469407f6f871c921697f73"
  },
  {
    "seatId": "C-006",
    "classCode": "C",
    "seatIndex": 6,
    "codeHash": "6be559bde011e27d08302f496b92a17dcc5b637117c825dec32c413b0274b648"
  },
  {
    "seatId": "C-007",
    "classCode": "C",
    "seatIndex": 7,
    "codeHash": "a06fac50f87a18f601105653e526506be5f5370145f6c260b093e30a06a32991"
  },
  {
    "seatId": "C-008",
    "classCode": "C",
    "seatIndex": 8,
    "codeHash": "76b51ebe220529f6a49f50b270d592de8a295b442882d0505a5ecc486d853c6f"
  },
  {
    "seatId": "C-009",
    "classCode": "C",
    "seatIndex": 9,
    "codeHash": "dddaf524f4e489e7265c8ec1dd9b7820ea3942fc294a2f9fcfdf8296b598c275"
  },
  {
    "seatId": "C-010",
    "classCode": "C",
    "seatIndex": 10,
    "codeHash": "57535f0525faa0e5857fd893aaf6727128b645815b1ef24f537390e7727c80e9"
  },
  {
    "seatId": "C-011",
    "classCode": "C",
    "seatIndex": 11,
    "codeHash": "459978aae1e49111f8d282f14c79e486ccabd86ec51c6e581b83f0af633ee7dd"
  },
  {
    "seatId": "C-012",
    "classCode": "C",
    "seatIndex": 12,
    "codeHash": "5067b8ee0f06923e2eb58a4e8983e69889e51344b6d845859ef37ad286f0b7b1"
  },
  {
    "seatId": "C-013",
    "classCode": "C",
    "seatIndex": 13,
    "codeHash": "5e14ae17253108227a4aae1e840448414d1e0016d34a536515a85ebcd624e8a3"
  },
  {
    "seatId": "C-014",
    "classCode": "C",
    "seatIndex": 14,
    "codeHash": "e093ff094f40b169c760293fdac0fbb8f1872805cd3d40be88aa385a07829d88"
  },
  {
    "seatId": "C-015",
    "classCode": "C",
    "seatIndex": 15,
    "codeHash": "8a11aa70be6d07254f039d2dd880114989d1d7156f0f1f10fd339be952273e83"
  },
  {
    "seatId": "C-016",
    "classCode": "C",
    "seatIndex": 16,
    "codeHash": "dd9d5374c8379ad238d15e745e6aeb61f2121db0232dffa4216c3d31d8210d4e"
  },
  {
    "seatId": "C-017",
    "classCode": "C",
    "seatIndex": 17,
    "codeHash": "088c19e142275b008529e986b5e930c708e5035f97a390f5bde7895aff7e2e80"
  },
  {
    "seatId": "C-018",
    "classCode": "C",
    "seatIndex": 18,
    "codeHash": "240c38cdb1215dac18b8b6b620983373b2fac0dfb21f0283618f89577add33f6"
  },
  {
    "seatId": "C-019",
    "classCode": "C",
    "seatIndex": 19,
    "codeHash": "b33003fb75b5519368e57fbc8d93cdb2e288c8fecc0b04b3c9021bb0493848bf"
  },
  {
    "seatId": "C-020",
    "classCode": "C",
    "seatIndex": 20,
    "codeHash": "fdeaa40cfd63a4412bc4787c60b196d693b41eebfcffd9d31d0b8853319fab92"
  },
  {
    "seatId": "C-021",
    "classCode": "C",
    "seatIndex": 21,
    "codeHash": "445282fec34fd17c0e9a082a39c17e1c797182904d09ebb0fa67a68a593bc5f3"
  },
  {
    "seatId": "C-022",
    "classCode": "C",
    "seatIndex": 22,
    "codeHash": "6a4390cd25947d9527f035ab98af9fe55da60195d5eb2e3ea9382e08a4518df6"
  },
  {
    "seatId": "C-023",
    "classCode": "C",
    "seatIndex": 23,
    "codeHash": "e8dd44261b3aeef507c781e72f927f71d5d2294daf250a1175da9365b66633af"
  },
  {
    "seatId": "C-024",
    "classCode": "C",
    "seatIndex": 24,
    "codeHash": "d33ada39cbd8ca93b1f95b1cf804586062aa9ff3b98a4cde4f710b2a2c894f78"
  },
  {
    "seatId": "C-025",
    "classCode": "C",
    "seatIndex": 25,
    "codeHash": "7de766a1e763646dfeae9d631022ec3908d792905a363c36ef323b13b61eb41f"
  },
  {
    "seatId": "C-026",
    "classCode": "C",
    "seatIndex": 26,
    "codeHash": "49fbe4be1e3089f98e9c4f8fef2df4a5ffcd8edeb495c4ef73c53659898eff8e"
  },
  {
    "seatId": "C-027",
    "classCode": "C",
    "seatIndex": 27,
    "codeHash": "74ee6e0ca2885094e48300765a9846567e6ba527b511fe718c0fc90034dbdaf1"
  },
  {
    "seatId": "C-028",
    "classCode": "C",
    "seatIndex": 28,
    "codeHash": "a9252f7baf79d910f1b9cb23cb7fefd40a5d2005b378e5051e82107fd25480c1"
  },
  {
    "seatId": "C-029",
    "classCode": "C",
    "seatIndex": 29,
    "codeHash": "3b1b21e27b8defcc08e8dd0eece641631e2cd297522427fe7f596f0d0b10768d"
  },
  {
    "seatId": "C-030",
    "classCode": "C",
    "seatIndex": 30,
    "codeHash": "f8d4976a063f6246d18ff9176f3df30076c541549165af402381f292efd841b6"
  },
  {
    "seatId": "C-031",
    "classCode": "C",
    "seatIndex": 31,
    "codeHash": "0316ec74552cc3b33b2b3b0c804abaccf45455fc44100504545734076540b734"
  },
  {
    "seatId": "C-032",
    "classCode": "C",
    "seatIndex": 32,
    "codeHash": "b2cbff0c5639fd5f71111be335f0466b7c03d52f5314188dae1e44ad598b9411"
  },
  {
    "seatId": "C-033",
    "classCode": "C",
    "seatIndex": 33,
    "codeHash": "7aa87564f90db625714a2fb1d3e4be1cb6af7bf87f1fbec82e812a1ddcb0ead0"
  },
  {
    "seatId": "C-034",
    "classCode": "C",
    "seatIndex": 34,
    "codeHash": "09593e214a56434cd5190dd798d720396d2bccf6a7ca1e44ee3aa0954170cd80"
  },
  {
    "seatId": "C-035",
    "classCode": "C",
    "seatIndex": 35,
    "codeHash": "75e7a9721604081f5fd27c07ece8080de81459bd61a3ddd7d411c28438d588fc"
  },
  {
    "seatId": "C-036",
    "classCode": "C",
    "seatIndex": 36,
    "codeHash": "df51be748056b50aaca492661b139d87de12b16298529daaf74b82fa4362f21f"
  },
  {
    "seatId": "C-037",
    "classCode": "C",
    "seatIndex": 37,
    "codeHash": "d2c960ad8590746f502726c85a984b76fedb250a3852b4157ceaed14f7a5e2dc"
  },
  {
    "seatId": "C-038",
    "classCode": "C",
    "seatIndex": 38,
    "codeHash": "ae3cf62451858c6db910e7d3426a4535c556c1496bac3ee86d3388d0452043fe"
  },
  {
    "seatId": "C-039",
    "classCode": "C",
    "seatIndex": 39,
    "codeHash": "03bc33f6a42e298828e7958343d79cf36d312f6d96db87dc68f19c98d3e666a8"
  },
  {
    "seatId": "C-040",
    "classCode": "C",
    "seatIndex": 40,
    "codeHash": "0f5760b35d1e9631552051272452d44b4691d738e6fb44b07e047e29a8d3d91e"
  },
  {
    "seatId": "C-041",
    "classCode": "C",
    "seatIndex": 41,
    "codeHash": "7023bcb8b8b16576f8f2ce5396a0a568dc4fa558c3c0cfae4fce2599bf5525b9"
  },
  {
    "seatId": "C-042",
    "classCode": "C",
    "seatIndex": 42,
    "codeHash": "3266a871a1488d8028bd67db070a8b39b691ce009f19bc468821368a53b80b50"
  },
  {
    "seatId": "C-043",
    "classCode": "C",
    "seatIndex": 43,
    "codeHash": "4706a5bc7149cee15de99e804962d2e57bd5106524729732277bbf8a2cf9a969"
  },
  {
    "seatId": "C-044",
    "classCode": "C",
    "seatIndex": 44,
    "codeHash": "ec8af798d7f75d773d63886eb8644417e0ce304c706589be94f9eda5978001cb"
  },
  {
    "seatId": "C-045",
    "classCode": "C",
    "seatIndex": 45,
    "codeHash": "4c9a49f87d7e7c6c79d00a1c4087cba8501366ad42980f1d68de3c87c096385e"
  },
  {
    "seatId": "C-046",
    "classCode": "C",
    "seatIndex": 46,
    "codeHash": "2d26c6bfcaed88385f173345e5618140e29dfb348195c4dcb540d7215ede0b84"
  },
  {
    "seatId": "C-047",
    "classCode": "C",
    "seatIndex": 47,
    "codeHash": "f939c5900fb09e9fa74b7ccdc2c87d2f7bf9d435232480111b07bf1cc375f0f0"
  },
  {
    "seatId": "C-048",
    "classCode": "C",
    "seatIndex": 48,
    "codeHash": "4eabb58db77822d086221bc182c6b45c39836b52427b2016dc5fe4f3267340e9"
  },
  {
    "seatId": "C-049",
    "classCode": "C",
    "seatIndex": 49,
    "codeHash": "f1fdddcddb451b2c6d732640c275505c8a4eef44b690a1197c1f405ff4fdb409"
  },
  {
    "seatId": "C-050",
    "classCode": "C",
    "seatIndex": 50,
    "codeHash": "1d5357f72ede2873cfdddc634f9f78c45fa130921643ccfc32670e856821c278"
  },
  {
    "seatId": "C-051",
    "classCode": "C",
    "seatIndex": 51,
    "codeHash": "46ef32792fad20c5da8fde1618a9266aa0647b722ef2dce8fc2107432be7da00"
  },
  {
    "seatId": "C-052",
    "classCode": "C",
    "seatIndex": 52,
    "codeHash": "4d315b1eac640533c8ab73709ed6c4b63ef569071924815016439e60f1fe4e30"
  },
  {
    "seatId": "C-053",
    "classCode": "C",
    "seatIndex": 53,
    "codeHash": "e8f46ca0ec3e829816d4d8a6dbf5ff36be30edd4f13805993eb3d45838bc8186"
  },
  {
    "seatId": "C-054",
    "classCode": "C",
    "seatIndex": 54,
    "codeHash": "8b9bbf751623ded922fbc14c4ec86ede211d2f06c9dfb6d502a2efc2f6b6dc43"
  },
  {
    "seatId": "C-055",
    "classCode": "C",
    "seatIndex": 55,
    "codeHash": "df143686c432e8cb7d497edc44dd3b856f14322cec694fb5f1dc74042022584a"
  },
  {
    "seatId": "C-056",
    "classCode": "C",
    "seatIndex": 56,
    "codeHash": "9bfcf7ed92dbeb486aa700a4144fd17b8699149bd32172aaae4e57ef3bef8533"
  },
  {
    "seatId": "C-057",
    "classCode": "C",
    "seatIndex": 57,
    "codeHash": "506b69e94de69f960b4ab1f6af722f2c5665e54c2c90751c3b8e7f731044bde6"
  },
  {
    "seatId": "C-058",
    "classCode": "C",
    "seatIndex": 58,
    "codeHash": "ced6f9c5153553cceb17b50b97355793755a58da257b8a735875ae981d09a6ae"
  },
  {
    "seatId": "C-059",
    "classCode": "C",
    "seatIndex": 59,
    "codeHash": "b12daf73618844a8490ba753c81a57baa81f97f95684942277b619c195a6f2e1"
  },
  {
    "seatId": "C-060",
    "classCode": "C",
    "seatIndex": 60,
    "codeHash": "c2683c65d9e578390427e703688a031bf0aa3d5707d0f61e08e1ec3b8aad62cc"
  },
  {
    "seatId": "C-061",
    "classCode": "C",
    "seatIndex": 61,
    "codeHash": "cdd0d0312778b4f30b3b35876d9ac7e82ad7ec85e7a25dcffba0c668c5d5ec35"
  },
  {
    "seatId": "C-062",
    "classCode": "C",
    "seatIndex": 62,
    "codeHash": "e35a53466c3b04c0f9ff54d49949e50d0b945d9c0aa5e268ecb50c2fafbe5cd3"
  },
  {
    "seatId": "C-063",
    "classCode": "C",
    "seatIndex": 63,
    "codeHash": "02473f4d301e4c8db7461ba37870e1fadeb0ee9908200b7c4a8883413c42410b"
  },
  {
    "seatId": "C-064",
    "classCode": "C",
    "seatIndex": 64,
    "codeHash": "8b1cd846f5670fd477b10a2497395544b75cdbf7f2983c3025439e71688c39a7"
  },
  {
    "seatId": "D-001",
    "classCode": "D",
    "seatIndex": 1,
    "codeHash": "7ed9373f808ebdc0912c7a9b61ac84faf772b0ce20aae821a397ebd16512654f"
  },
  {
    "seatId": "D-002",
    "classCode": "D",
    "seatIndex": 2,
    "codeHash": "e0981527d5850e2a99d6db09a8011de50b404f18237f1b3a6965528b5a833a67"
  },
  {
    "seatId": "D-003",
    "classCode": "D",
    "seatIndex": 3,
    "codeHash": "f3d22e2d9a9d485a720fcd4cc4f9480abc63c2cb93d46f79efcddb990842ca94"
  },
  {
    "seatId": "D-004",
    "classCode": "D",
    "seatIndex": 4,
    "codeHash": "ca63b41f5281cb207d3eab90a0a7f8a77956dc1fbc5d397e51f1a70c8383274a"
  },
  {
    "seatId": "D-005",
    "classCode": "D",
    "seatIndex": 5,
    "codeHash": "0bf3caabf1900d57103d5d3ce687516839d35ea81b7b31e83c7743ab703d4757"
  },
  {
    "seatId": "D-006",
    "classCode": "D",
    "seatIndex": 6,
    "codeHash": "b4c95eae601fdb63a4f3f1044c37e449f2ef6045efc8fdc7621f12dca4bc0dd8"
  },
  {
    "seatId": "D-007",
    "classCode": "D",
    "seatIndex": 7,
    "codeHash": "c55edc8cd097ac96512ee762f3b958334355ef90eb1ee2c76b5e0e1c5cff4e8d"
  },
  {
    "seatId": "D-008",
    "classCode": "D",
    "seatIndex": 8,
    "codeHash": "434a290a6d0df30cdda4d4556ac71d0b817aa2f4c7d0746bc13b61de5f360632"
  },
  {
    "seatId": "D-009",
    "classCode": "D",
    "seatIndex": 9,
    "codeHash": "5c05230445b17b16f58c11686faf7c1ddb07bc8c1dad7fc73233767ecd0f0518"
  },
  {
    "seatId": "D-010",
    "classCode": "D",
    "seatIndex": 10,
    "codeHash": "27447eba65b0e68232a89da04b96d83c2166187df90aad87932d0fad45f04766"
  },
  {
    "seatId": "D-011",
    "classCode": "D",
    "seatIndex": 11,
    "codeHash": "fc9847e742e55186c7349c31b3fe9f0f0f3e51c5d3cd6141f583571434dc163e"
  },
  {
    "seatId": "D-012",
    "classCode": "D",
    "seatIndex": 12,
    "codeHash": "03bf811ad360338525528df58a93322e963ef2b37d869866a589dc2545f5b6e7"
  },
  {
    "seatId": "D-013",
    "classCode": "D",
    "seatIndex": 13,
    "codeHash": "63c12356b647be44c27c46a87b3025760f115373b1501bd51258a010524a35b6"
  },
  {
    "seatId": "D-014",
    "classCode": "D",
    "seatIndex": 14,
    "codeHash": "8b4c2611e5b478a2e9400deb38615fa6134f82fa9b635d5c2312f4ed6bb0204b"
  },
  {
    "seatId": "D-015",
    "classCode": "D",
    "seatIndex": 15,
    "codeHash": "3e9cca4a3bb654587a37df0cfe1e170e5ef42bdfc6c6af5d6541aa036b7ce684"
  },
  {
    "seatId": "D-016",
    "classCode": "D",
    "seatIndex": 16,
    "codeHash": "5050ea768570295ee248dae18fc317bc0d258ddbf4bc1861adb57514babf0060"
  },
  {
    "seatId": "D-017",
    "classCode": "D",
    "seatIndex": 17,
    "codeHash": "148161cc5563076102be2a6eeafb540c2cfbd8b2ea7e7675aaea073df5663b41"
  },
  {
    "seatId": "D-018",
    "classCode": "D",
    "seatIndex": 18,
    "codeHash": "4dd86a31d2d29de0f6006c5c090f70d66cdca48f60666f9c3f95df8b9d3c8afe"
  },
  {
    "seatId": "D-019",
    "classCode": "D",
    "seatIndex": 19,
    "codeHash": "27043f6a73842ebec9654218c1a0b6b8496b80624ceb751845df2e54bae1cc9a"
  },
  {
    "seatId": "D-020",
    "classCode": "D",
    "seatIndex": 20,
    "codeHash": "1e713b4bfdc0afbbc211b47249a6ae89bef0873a5be51ba26045a3f03580a12c"
  },
  {
    "seatId": "D-021",
    "classCode": "D",
    "seatIndex": 21,
    "codeHash": "66a10c2e75aad047c4cb86559e8ccdadeae6a7d8781d9651d4f4870a5f156570"
  },
  {
    "seatId": "D-022",
    "classCode": "D",
    "seatIndex": 22,
    "codeHash": "50e371ed5f21e96a531e5e7e493ae5fcd0376f62a909da1fb37771ae2c52f1c2"
  },
  {
    "seatId": "D-023",
    "classCode": "D",
    "seatIndex": 23,
    "codeHash": "72447a32a2ba95ce6cb8f097729aa37b43ec903873bb6986f02ce433eebf23a1"
  },
  {
    "seatId": "D-024",
    "classCode": "D",
    "seatIndex": 24,
    "codeHash": "dd471c3aa873c3132fc73fb5d2c035e4a82eef922cd020ba0580fc2bf6570be1"
  },
  {
    "seatId": "D-025",
    "classCode": "D",
    "seatIndex": 25,
    "codeHash": "48201df864badb0f11074ac9835e3a9609274fb92a3f6015b29c6f634a07f555"
  },
  {
    "seatId": "D-026",
    "classCode": "D",
    "seatIndex": 26,
    "codeHash": "6ba6d34cae6241528cba61eb722e60621a7ec8da8892c78db2585cefbc013e67"
  },
  {
    "seatId": "D-027",
    "classCode": "D",
    "seatIndex": 27,
    "codeHash": "c881b52b00cb518513bf1470a4e11e9fd145e41197c15884a597f759edbe1108"
  },
  {
    "seatId": "D-028",
    "classCode": "D",
    "seatIndex": 28,
    "codeHash": "056947a8f569fadbf496bdb0d6cb3308e49c274fd8a073f322912f8b8a3beaf5"
  },
  {
    "seatId": "D-029",
    "classCode": "D",
    "seatIndex": 29,
    "codeHash": "ed82949790eae22f3bbc9e79ddf3724faa55e1a3e8ffc9e1713901ca1936e6ba"
  },
  {
    "seatId": "D-030",
    "classCode": "D",
    "seatIndex": 30,
    "codeHash": "ef890c19f6d5ddb13ede4e943b93d7eaef8c608b42da4f28634534a53ba21be2"
  },
  {
    "seatId": "D-031",
    "classCode": "D",
    "seatIndex": 31,
    "codeHash": "94fb40d568bef5c013cd99e778128fd8e597882cb1e20278ffe92ab47a447019"
  },
  {
    "seatId": "D-032",
    "classCode": "D",
    "seatIndex": 32,
    "codeHash": "858ee63e436497092094b151d1a08bba91e400f0fce2c22d0d78199ef513e3ad"
  },
  {
    "seatId": "D-033",
    "classCode": "D",
    "seatIndex": 33,
    "codeHash": "c7d1a913889b69a9e85e38e35b77ac5f4a135cebf108a173c2bc91ca61ecdce4"
  },
  {
    "seatId": "D-034",
    "classCode": "D",
    "seatIndex": 34,
    "codeHash": "e8d02d5225d789a66eeff1fc25edcc0518b08f5a872f8b9d4bc67efe0efc1e89"
  },
  {
    "seatId": "D-035",
    "classCode": "D",
    "seatIndex": 35,
    "codeHash": "0d343884fdb40dc2113ca5be6c9dbe056ffb802e6330d2891201d4dece0a3993"
  },
  {
    "seatId": "D-036",
    "classCode": "D",
    "seatIndex": 36,
    "codeHash": "790b4fe3d820f33be4c5c8675bd2318b016a4b922de0b2c782ca8ca9f413d79f"
  },
  {
    "seatId": "D-037",
    "classCode": "D",
    "seatIndex": 37,
    "codeHash": "11c5f0941ea0353a72141fa8363abdecd0435743acd3b4823f745b6d35b13e02"
  },
  {
    "seatId": "D-038",
    "classCode": "D",
    "seatIndex": 38,
    "codeHash": "ca899953bcfc44635c68a3edc08bac6f73382639c39bf76258645e4b2ddcfefc"
  },
  {
    "seatId": "D-039",
    "classCode": "D",
    "seatIndex": 39,
    "codeHash": "4efa96f63af9cd25396b0f2819b475ab716f4370847fd644d0f4d7cbc35ce345"
  },
  {
    "seatId": "D-040",
    "classCode": "D",
    "seatIndex": 40,
    "codeHash": "5d66779723f14f315b7806f76b7e16fad0116e19e60ec7aa6d8585f5749b0eca"
  },
  {
    "seatId": "D-041",
    "classCode": "D",
    "seatIndex": 41,
    "codeHash": "1663a05da23c59f0469d4e972121b60ae75ed8d735575929a2a6a41858ae7522"
  },
  {
    "seatId": "D-042",
    "classCode": "D",
    "seatIndex": 42,
    "codeHash": "c73e8dda109388d37666d6a529363fb5d182fcfb478f7752b75d0fcffad44315"
  },
  {
    "seatId": "D-043",
    "classCode": "D",
    "seatIndex": 43,
    "codeHash": "240ed1664d12bd20cf33f591de3d3f0623a367e582c8cc6595eb15c25a26d760"
  },
  {
    "seatId": "D-044",
    "classCode": "D",
    "seatIndex": 44,
    "codeHash": "9b1e56eec426fc7d7a4ca1cf8a45ddf81a2a76dc744e8963b408ec4a500942d0"
  },
  {
    "seatId": "D-045",
    "classCode": "D",
    "seatIndex": 45,
    "codeHash": "321ee864ec4d0810aa83fe8378eabd2bb97a24dab826110ef9f2839c5a492ea8"
  },
  {
    "seatId": "D-046",
    "classCode": "D",
    "seatIndex": 46,
    "codeHash": "661b284f510583383ac2928956beefbb991c37c28208b44748a7c6b2e803eb21"
  },
  {
    "seatId": "D-047",
    "classCode": "D",
    "seatIndex": 47,
    "codeHash": "c42f300d5bef38a53e7f33f600448117080b550f24802bb98f90db3d4cb36f20"
  },
  {
    "seatId": "D-048",
    "classCode": "D",
    "seatIndex": 48,
    "codeHash": "6deae5c2d153432a9498f1a5105fe2b3e8213fccd95ca0109f084a78aae41d72"
  },
  {
    "seatId": "D-049",
    "classCode": "D",
    "seatIndex": 49,
    "codeHash": "9b40141ae71bf6976b570aee6f97596fabf7b99d6e7f630a738732d3abd2c54f"
  },
  {
    "seatId": "D-050",
    "classCode": "D",
    "seatIndex": 50,
    "codeHash": "0a602d76c96286fd564170d044eeb352cb050d899d8c30014028a460fa5cbc48"
  },
  {
    "seatId": "D-051",
    "classCode": "D",
    "seatIndex": 51,
    "codeHash": "4915a0d564b0dfc5cfc4f8d57fc8897d0135da559050ef2199ad2ac2219c1d2c"
  },
  {
    "seatId": "D-052",
    "classCode": "D",
    "seatIndex": 52,
    "codeHash": "f16ef33f71519b6ddf598daa679b289f903ed8e629c32a67968d75345cb213f5"
  },
  {
    "seatId": "D-053",
    "classCode": "D",
    "seatIndex": 53,
    "codeHash": "5e473e29e50a00e092294a0c56d83d5cb756acc175d30f63ee2798e8556c20a4"
  },
  {
    "seatId": "D-054",
    "classCode": "D",
    "seatIndex": 54,
    "codeHash": "17a4601126fd9f76c595b0cf4d57f76902d93d9c3e8d57c4fdd568857574c7f4"
  },
  {
    "seatId": "D-055",
    "classCode": "D",
    "seatIndex": 55,
    "codeHash": "d00b0a5dc48dd95cbd197269511f516439088af987447e62bd3ee429e2ab62c9"
  },
  {
    "seatId": "D-056",
    "classCode": "D",
    "seatIndex": 56,
    "codeHash": "ad1c0e88f13bbeaa7cc2663917c003cb4f2d2d465abeb339793dafd8259d1cff"
  },
  {
    "seatId": "D-057",
    "classCode": "D",
    "seatIndex": 57,
    "codeHash": "43c0ae1b76c29055e1f7a05084c7c26cf621fbf454acd462aa708482eadee5bf"
  },
  {
    "seatId": "D-058",
    "classCode": "D",
    "seatIndex": 58,
    "codeHash": "88eb8fbd342010b448362214d4577dd4af166e13eea79cc3b55f8cc499dbe1e7"
  },
  {
    "seatId": "D-059",
    "classCode": "D",
    "seatIndex": 59,
    "codeHash": "0d74eae15cb31cda2fc425913233d73875ec5c0611c6b33d2d76b34e7c98e2e5"
  },
  {
    "seatId": "D-060",
    "classCode": "D",
    "seatIndex": 60,
    "codeHash": "92ae7905e497cb8e37a3fe41cb6f82175d83cdd77834649d33489a75e5b90ee3"
  },
  {
    "seatId": "D-061",
    "classCode": "D",
    "seatIndex": 61,
    "codeHash": "fee3acde894725cc18516c6efa6eac4d6b51785e763006b5cc121b0ad6f5e73b"
  },
  {
    "seatId": "D-062",
    "classCode": "D",
    "seatIndex": 62,
    "codeHash": "aeeabc34bf63a7919ff5ddac247cc870d1f857d0b4e6a85bee634427a7ede737"
  },
  {
    "seatId": "D-063",
    "classCode": "D",
    "seatIndex": 63,
    "codeHash": "98265bfe7bb17458ef74b026a772d00b0b69d5a2402afd59a9cd8c68f0206112"
  },
  {
    "seatId": "D-064",
    "classCode": "D",
    "seatIndex": 64,
    "codeHash": "82ebc47308cc049b4aba19432f6edd980b74fdc94542e51053dae1854c57c553"
  },
  {
    "seatId": "D-065",
    "classCode": "D",
    "seatIndex": 65,
    "codeHash": "054cfbe906e833fb618a54b56a87d03437a276cda05cd0306236bc818f426b48"
  },
  {
    "seatId": "D-066",
    "classCode": "D",
    "seatIndex": 66,
    "codeHash": "d6d537887074c8c36890518b7ec6d62c36ce261bc8b0ff1b63af36fab8f40335"
  },
  {
    "seatId": "D-067",
    "classCode": "D",
    "seatIndex": 67,
    "codeHash": "c8b95df36cb90e99808cd3f07826cc1253499b0abee216c42361e34f96e0014f"
  },
  {
    "seatId": "D-068",
    "classCode": "D",
    "seatIndex": 68,
    "codeHash": "d1703f8b8b93dcbf4bbf6feada4564cc9a19de98f214f071dba52e5c78c8fe4c"
  },
  {
    "seatId": "D-069",
    "classCode": "D",
    "seatIndex": 69,
    "codeHash": "6257193665ca81ae5851a1b028e7f4619c009f0132721f247d71b90722cf65af"
  },
  {
    "seatId": "D-070",
    "classCode": "D",
    "seatIndex": 70,
    "codeHash": "9a10f7b3e54522f2fc8043bad5a14dcdffc6c674ba86fd4dcf81f85435b91cc8"
  },
  {
    "seatId": "D-071",
    "classCode": "D",
    "seatIndex": 71,
    "codeHash": "3b175c8c0718668035c8164bb562719c60a05cb4d453e957a663e5317109b8e9"
  },
  {
    "seatId": "D-072",
    "classCode": "D",
    "seatIndex": 72,
    "codeHash": "f7ed11832770bd6a46bc26858007e82853e2384999cc771986a62745758cb0b3"
  },
  {
    "seatId": "D-073",
    "classCode": "D",
    "seatIndex": 73,
    "codeHash": "bcfe6f1ebffebf46f587b31cc503475c6828f45ee9c5e84407a99d401024d8e2"
  },
  {
    "seatId": "D-074",
    "classCode": "D",
    "seatIndex": 74,
    "codeHash": "24d9b326181234d41819f3185bb438eace2e2aea852aa5be56c3e0dec4427430"
  },
  {
    "seatId": "D-075",
    "classCode": "D",
    "seatIndex": 75,
    "codeHash": "04bebe01b5b5fd68bc3fe50bd045bfa348513ce06491608b9fcd0a34a1f80a18"
  },
  {
    "seatId": "D-076",
    "classCode": "D",
    "seatIndex": 76,
    "codeHash": "55b19e0ddfb1bb80dcb37343c58b6d2933bdebbb7a01d2e607746815b33d8d50"
  },
  {
    "seatId": "D-077",
    "classCode": "D",
    "seatIndex": 77,
    "codeHash": "440f87d77f28709e63edce9f17101acc76ef125423163d5e9fad123dd6957c74"
  },
  {
    "seatId": "D-078",
    "classCode": "D",
    "seatIndex": 78,
    "codeHash": "113ad8f51e9863e0d4ca4b7f0e2c31a3f12e598918533b8c0f7f8d0c0e8ac3c2"
  },
  {
    "seatId": "D-079",
    "classCode": "D",
    "seatIndex": 79,
    "codeHash": "38b7b5341f33b7d0374e3e1a99c9af267dd73e3129436b3b3d32f5e2b2778235"
  },
  {
    "seatId": "D-080",
    "classCode": "D",
    "seatIndex": 80,
    "codeHash": "87c5457e413c79b6f36a06728b3a2d5df8557c506f2d32c007619b123695e82f"
  },
  {
    "seatId": "D-081",
    "classCode": "D",
    "seatIndex": 81,
    "codeHash": "e6ea05f6a35d8c4ba5dc1cf5cabe43eed0d15e7f5af67eb8272e714932bb0407"
  },
  {
    "seatId": "D-082",
    "classCode": "D",
    "seatIndex": 82,
    "codeHash": "dd0b31675ee1a26582c2823e711cf3cd969bef5028cfde556b863f12bd51bca0"
  },
  {
    "seatId": "D-083",
    "classCode": "D",
    "seatIndex": 83,
    "codeHash": "dfbaae60fffe9cfc3aa5604381f6bee1f1e16a4747dfac4e90a10e7eeb0996e1"
  },
  {
    "seatId": "D-084",
    "classCode": "D",
    "seatIndex": 84,
    "codeHash": "afb62ea0ad7882e81f7423ec2ace59a133ffbfd02bd6ecde7bab392b8c52f117"
  },
  {
    "seatId": "D-085",
    "classCode": "D",
    "seatIndex": 85,
    "codeHash": "aff140c8cd8e33821db345d842a4e91c485dd9ef8bc36170b6b78b32cc74729b"
  },
  {
    "seatId": "D-086",
    "classCode": "D",
    "seatIndex": 86,
    "codeHash": "bccaba506b2afe6c52dae876727d2f4b2350243392d0945301ce97f0cfb07bfc"
  },
  {
    "seatId": "D-087",
    "classCode": "D",
    "seatIndex": 87,
    "codeHash": "339b99b38d7f2343f209dc686d54fe08d2d1db0be1f2600bc19b3fcd35602ff3"
  },
  {
    "seatId": "D-088",
    "classCode": "D",
    "seatIndex": 88,
    "codeHash": "5c9cd4d3fe66bc211e4a7d4b1784a0845434126ae18f0052b6e3789c42a17a17"
  },
  {
    "seatId": "D-089",
    "classCode": "D",
    "seatIndex": 89,
    "codeHash": "b7e33709e3d8c8efe062e4b86ee7f6c14876a7d75294a7014d50abd45f79b286"
  },
  {
    "seatId": "D-090",
    "classCode": "D",
    "seatIndex": 90,
    "codeHash": "63b3f6b3f5ef5ef3a7dcacf90dfb24fb13a2e4ea0ce40100bbbc8db9773f0b27"
  },
  {
    "seatId": "D-091",
    "classCode": "D",
    "seatIndex": 91,
    "codeHash": "a4c49180ff822b3f0b3abc7984f3c2b3a9464a738215373403dc94b264d27c5a"
  },
  {
    "seatId": "D-092",
    "classCode": "D",
    "seatIndex": 92,
    "codeHash": "ff581ab81f1767dad2e7140c5fdd7b170cbf5b1750d7ec047810ddf8ef1d8640"
  },
  {
    "seatId": "D-093",
    "classCode": "D",
    "seatIndex": 93,
    "codeHash": "917d1a7badf048afbf9c01b22fec882f0661be56dc15e5cc56a7e95a6fb273b4"
  },
  {
    "seatId": "D-094",
    "classCode": "D",
    "seatIndex": 94,
    "codeHash": "76c05e2922ff32ec303c348f97def43f56e02f6a3095068f673cc9a3d3af0fc6"
  },
  {
    "seatId": "D-095",
    "classCode": "D",
    "seatIndex": 95,
    "codeHash": "27416055c73ed336437dd9f63e91b7580df5dbbe80873e8c08736903f4f1389b"
  },
  {
    "seatId": "D-096",
    "classCode": "D",
    "seatIndex": 96,
    "codeHash": "ea199ddc0be44e18d538b138a022fa3d33049a8b7e0508f13a4b6fc2639bca6e"
  },
  {
    "seatId": "E-001",
    "classCode": "E",
    "seatIndex": 1,
    "codeHash": "c6354668dae68f551307f8d856d664adf2e8c4e43edccb73493c116bedff94e7"
  },
  {
    "seatId": "E-002",
    "classCode": "E",
    "seatIndex": 2,
    "codeHash": "bf826ae89586b6e04fb14435d622dc8b3dfdcf98bd7a03709647f1f683549d2a"
  },
  {
    "seatId": "E-003",
    "classCode": "E",
    "seatIndex": 3,
    "codeHash": "8e91c2621baaf95c7c8392d72c1febc957d2435fb9f3393e6201d2b9724f5f9d"
  },
  {
    "seatId": "E-004",
    "classCode": "E",
    "seatIndex": 4,
    "codeHash": "938ba7c76c3d5f5dcc24ce54bc5431c351ed628f21df4ff5eaae202b30794e76"
  },
  {
    "seatId": "E-005",
    "classCode": "E",
    "seatIndex": 5,
    "codeHash": "a46033778a9216fad5c77a30d6e733b76e27d738645170cf6f3548e563f8d1c3"
  },
  {
    "seatId": "E-006",
    "classCode": "E",
    "seatIndex": 6,
    "codeHash": "4c872ab4a6ac1f80f9a7c5d62aa60406c048a7d962b5792cb812182f3966d497"
  },
  {
    "seatId": "E-007",
    "classCode": "E",
    "seatIndex": 7,
    "codeHash": "82a878ddbc52235b42b37b84a8100698626829b742e062d4dc6b64eed8a6ceec"
  },
  {
    "seatId": "E-008",
    "classCode": "E",
    "seatIndex": 8,
    "codeHash": "6504b5f96f2a6eba15114a194518906161b3d8c8caa9128e1321e19870c31a1f"
  },
  {
    "seatId": "E-009",
    "classCode": "E",
    "seatIndex": 9,
    "codeHash": "46c426114c07b42132c26ff496f568e818b93b44e53d1bcbdfa3a60e39a7afdc"
  },
  {
    "seatId": "E-010",
    "classCode": "E",
    "seatIndex": 10,
    "codeHash": "f01e5c4475a5290ca9c76aff7bf65dcb4db2321bd682e4fc464f1c8cc674141d"
  },
  {
    "seatId": "E-011",
    "classCode": "E",
    "seatIndex": 11,
    "codeHash": "263d24ec5ae3c04a258b526a07e1e797f1e741d47fe070ecbe8f0a4c0a050902"
  },
  {
    "seatId": "E-012",
    "classCode": "E",
    "seatIndex": 12,
    "codeHash": "0d8fcb2a2c84c915d98a01b1a25385ca067859d3c6ec234ec9d52844acba0ed0"
  },
  {
    "seatId": "E-013",
    "classCode": "E",
    "seatIndex": 13,
    "codeHash": "4ec8c89b10ff80b3f504300325fdeaa50ed1a9ef5d7f18d831f0517214d23258"
  },
  {
    "seatId": "E-014",
    "classCode": "E",
    "seatIndex": 14,
    "codeHash": "84ad73a636c1f251e0cb1dfe3b80abfa4aa4a14f0ceba6f670c1501728625cc9"
  },
  {
    "seatId": "E-015",
    "classCode": "E",
    "seatIndex": 15,
    "codeHash": "be0f03fc0052ec673744f5b470946f4955e2274f2ba1099f2939d4d291d1fc4a"
  },
  {
    "seatId": "E-016",
    "classCode": "E",
    "seatIndex": 16,
    "codeHash": "dec1a05a050638c343b84d8dc2c415ffc90e859da47f99c527fdf933a7d19991"
  },
  {
    "seatId": "E-017",
    "classCode": "E",
    "seatIndex": 17,
    "codeHash": "7e45c843b10613d5b4eb4b7b441fc82e0356edbe88e2bbaa24298e118f53efe8"
  },
  {
    "seatId": "E-018",
    "classCode": "E",
    "seatIndex": 18,
    "codeHash": "499d9aa1aab2cfe3134f4b0ea54027955be8ed0d77582693edd1e43b4a7e2dca"
  },
  {
    "seatId": "E-019",
    "classCode": "E",
    "seatIndex": 19,
    "codeHash": "61530ad4ddc6ea3d8288f450c0295264d22d25f4d99331b80d6d133e2556ff81"
  },
  {
    "seatId": "E-020",
    "classCode": "E",
    "seatIndex": 20,
    "codeHash": "4b3c4c06f70441be046d43978af7f67db8b9b55012b221a58e94c44c923a650f"
  },
  {
    "seatId": "E-021",
    "classCode": "E",
    "seatIndex": 21,
    "codeHash": "2658d0ac40eb46909e92a4fbf83f7a64253e6a5a9c5d02b693769c563aabc362"
  },
  {
    "seatId": "E-022",
    "classCode": "E",
    "seatIndex": 22,
    "codeHash": "12410221978adeae2af59c5de5b97505adc88d5bee926b2f22cdca2fbef4ef03"
  },
  {
    "seatId": "E-023",
    "classCode": "E",
    "seatIndex": 23,
    "codeHash": "0df0482256896aa46ea0d0cb7abe376371aa0818b1e86bded8ed780023632cc8"
  },
  {
    "seatId": "E-024",
    "classCode": "E",
    "seatIndex": 24,
    "codeHash": "398c54153e92150194194ce33bda224dc00a0ddc9a12fcdd0adb6c9172a78793"
  },
  {
    "seatId": "E-025",
    "classCode": "E",
    "seatIndex": 25,
    "codeHash": "632b043e36025e56bdd91aac5ad93c37205eca8a0c35c82fd6b51d312982b746"
  },
  {
    "seatId": "E-026",
    "classCode": "E",
    "seatIndex": 26,
    "codeHash": "fddef7d40a5e9cbb3b075981749988072af1e6cfc70c4b3292ca921cf3a5e7da"
  },
  {
    "seatId": "E-027",
    "classCode": "E",
    "seatIndex": 27,
    "codeHash": "332109c63e4bc1145c4450acd21b9d2b8ebe75fbcca06da53f51b6b5ec782525"
  },
  {
    "seatId": "E-028",
    "classCode": "E",
    "seatIndex": 28,
    "codeHash": "7b96b1d589da1d6f6a4c56d0704998cb9ece6e0b3f7cb314f46aaac41acf3a4e"
  },
  {
    "seatId": "E-029",
    "classCode": "E",
    "seatIndex": 29,
    "codeHash": "7c23f4c08538c6137c9ba0213dd586562f9f812bc553b8e2eda5a3cd633cc490"
  },
  {
    "seatId": "E-030",
    "classCode": "E",
    "seatIndex": 30,
    "codeHash": "6c0ac62a39d30c85091d8153761efaed08c52d383212c1d9956e7b0099c66de5"
  },
  {
    "seatId": "E-031",
    "classCode": "E",
    "seatIndex": 31,
    "codeHash": "d0f9454b3d9d3136d9df2a94a5aa39068852c2d790b2ea175b42c0661ca647d4"
  },
  {
    "seatId": "E-032",
    "classCode": "E",
    "seatIndex": 32,
    "codeHash": "d8512a8ded83d76bfeb8afd15af4dadf8414a238b70d54bce9b80ce2534a1be6"
  },
  {
    "seatId": "E-033",
    "classCode": "E",
    "seatIndex": 33,
    "codeHash": "8a7dc5e81bb942b5c1e2cf3902cf0d793ffd806cd8647cb7403ff70907690df3"
  },
  {
    "seatId": "E-034",
    "classCode": "E",
    "seatIndex": 34,
    "codeHash": "145fc62a060eec054089f1b2379a0cf3792c9bfd733d4cb718ef5885bf739ca7"
  },
  {
    "seatId": "E-035",
    "classCode": "E",
    "seatIndex": 35,
    "codeHash": "f6810fa73e80930ddfd039b2ffea00b4b229651c7b058430157a44e448c84e75"
  },
  {
    "seatId": "E-036",
    "classCode": "E",
    "seatIndex": 36,
    "codeHash": "98cc73d25bb2f6f9642507d569145a2868a22d73efe14d233efc3f537f683d39"
  },
  {
    "seatId": "E-037",
    "classCode": "E",
    "seatIndex": 37,
    "codeHash": "8f76983a2d2d742ebe0bde1c40b5523fdf625b630009d8a1d5c53c4c72949c85"
  },
  {
    "seatId": "E-038",
    "classCode": "E",
    "seatIndex": 38,
    "codeHash": "4669957eb79d852a52d952751c310ebe529c3d9057e78c2ef071410595f8b6bb"
  },
  {
    "seatId": "E-039",
    "classCode": "E",
    "seatIndex": 39,
    "codeHash": "0a1e1262668e8377779ebb2bda59ef2c408a5f53977121956a1b27c4336a800b"
  },
  {
    "seatId": "E-040",
    "classCode": "E",
    "seatIndex": 40,
    "codeHash": "33aaa23fcf15019927f24f575323409ecdc1afcaa4d1a0b2e2f1b9dee6a7655b"
  },
  {
    "seatId": "E-041",
    "classCode": "E",
    "seatIndex": 41,
    "codeHash": "3a1ba8c9bf9cc4d84c4fdb5fb66ce4677794801a7415420a4feaf4f602533dc3"
  },
  {
    "seatId": "E-042",
    "classCode": "E",
    "seatIndex": 42,
    "codeHash": "e9bc9096b3a1f7241cc3668532882ae58e594bd265be0f99854b7113ddcb1484"
  },
  {
    "seatId": "E-043",
    "classCode": "E",
    "seatIndex": 43,
    "codeHash": "51aa44c721476ef07263dbe6ac459a96f5329341c96e346cb30af7300676eff4"
  },
  {
    "seatId": "E-044",
    "classCode": "E",
    "seatIndex": 44,
    "codeHash": "3da2b7301ffe9be7f76412188e94140539edea0e7560e35df71cabf7eace4d40"
  },
  {
    "seatId": "E-045",
    "classCode": "E",
    "seatIndex": 45,
    "codeHash": "42c4a3eb40b138115fa2f97cc8cf1630073756e8efc53538b5efa380aa7d73ce"
  },
  {
    "seatId": "E-046",
    "classCode": "E",
    "seatIndex": 46,
    "codeHash": "d7d7d1aad3e23b146713aa3c5d4dbf01a18ca144825cbdcdc438c8c6d1d2c60a"
  },
  {
    "seatId": "E-047",
    "classCode": "E",
    "seatIndex": 47,
    "codeHash": "bfb4bcc20b0dcff19891eb30ff4866fdb6e76cac35e2860c7a97fbcf1cf8be38"
  },
  {
    "seatId": "E-048",
    "classCode": "E",
    "seatIndex": 48,
    "codeHash": "78b7c02ea989a539675f2a4f54b68b909e24c44d3bdf5dc46b84abc7757d4aff"
  },
  {
    "seatId": "E-049",
    "classCode": "E",
    "seatIndex": 49,
    "codeHash": "6e2ab70ae2fa48f451f3815e47051c113a4a5a76289e263a10bbbdb1f1398164"
  },
  {
    "seatId": "E-050",
    "classCode": "E",
    "seatIndex": 50,
    "codeHash": "40bf5a52eef27730dd18942205c4c0c62bb88030df58f055e223a8884ebcc0d7"
  },
  {
    "seatId": "E-051",
    "classCode": "E",
    "seatIndex": 51,
    "codeHash": "a9e18cc842d4e66e3889f0c5e8ea07cd98ed8ae21455385bccf2f57014f8314e"
  },
  {
    "seatId": "E-052",
    "classCode": "E",
    "seatIndex": 52,
    "codeHash": "016e55a2333a2c60fd718767c66917c74b6c67d60de58f120f9ee9ed7d9312ca"
  },
  {
    "seatId": "E-053",
    "classCode": "E",
    "seatIndex": 53,
    "codeHash": "6c760d554a5e31853e7d879eaf5c3524f6546ac08c70e5df5a98d8daedb7bd2b"
  },
  {
    "seatId": "E-054",
    "classCode": "E",
    "seatIndex": 54,
    "codeHash": "ed779ac48570bb1bbc28de7503b1c6c6f931549616e20372a1f0375402399ef3"
  },
  {
    "seatId": "E-055",
    "classCode": "E",
    "seatIndex": 55,
    "codeHash": "5aab2c5bfbbe7444b26856379dc8f07f12cd1a43eed0f2456f82c05107ccb1ab"
  },
  {
    "seatId": "E-056",
    "classCode": "E",
    "seatIndex": 56,
    "codeHash": "5511a1ad22e3dbdbccb5d04adef27bfd40aa1b5fd0b1d4dcfddbecf4fd450daf"
  },
  {
    "seatId": "E-057",
    "classCode": "E",
    "seatIndex": 57,
    "codeHash": "f73ee61e9f1c861e2e781f1c18e7ea7b9cecc0ccc1b69366df4b6ac8087db1dc"
  },
  {
    "seatId": "E-058",
    "classCode": "E",
    "seatIndex": 58,
    "codeHash": "14f2eaf4217fa0467db123ab1c832ea2479b4edf28ea6a8981a50adfeb94531b"
  },
  {
    "seatId": "E-059",
    "classCode": "E",
    "seatIndex": 59,
    "codeHash": "9fb9f3e49dcaf9efea70fbd1caca84a14a84347fe7ff33ac0093a523eff403c9"
  },
  {
    "seatId": "E-060",
    "classCode": "E",
    "seatIndex": 60,
    "codeHash": "bebae9f3c6b4fb5d4986594b4fa1af089b44af4ae180babc96f1c411a6685629"
  },
  {
    "seatId": "E-061",
    "classCode": "E",
    "seatIndex": 61,
    "codeHash": "27151aadccf3c8a91a1c90397604becf2f2870a64442650198e719c524eda99f"
  },
  {
    "seatId": "E-062",
    "classCode": "E",
    "seatIndex": 62,
    "codeHash": "c663745ff4d3e0c9c38b8d64975ce3ef20412d208515db060ac78a08b6f4c866"
  },
  {
    "seatId": "E-063",
    "classCode": "E",
    "seatIndex": 63,
    "codeHash": "e0255b5e9b34dfb74ff0bee543dd437bc161c315de8c1676469aaf9aa94b8384"
  },
  {
    "seatId": "E-064",
    "classCode": "E",
    "seatIndex": 64,
    "codeHash": "6421f9cf4ba6ecdc20262cf92bf721cf40f74d8f180ad77f483d1ea1c80c792b"
  },
  {
    "seatId": "E-065",
    "classCode": "E",
    "seatIndex": 65,
    "codeHash": "9a2576378505a87d4cc89d62b8819d5da73fd95a1d72d1ef16f066cf98e06abc"
  },
  {
    "seatId": "E-066",
    "classCode": "E",
    "seatIndex": 66,
    "codeHash": "992c71da789ecb0406c7d6105406643397a53bd5a9fa23072a83be5d677797af"
  },
  {
    "seatId": "E-067",
    "classCode": "E",
    "seatIndex": 67,
    "codeHash": "6ba32017c1adafcadcf9f9ec26c8b8f9424ff0a74c0efec868c499b40b8b7b68"
  },
  {
    "seatId": "E-068",
    "classCode": "E",
    "seatIndex": 68,
    "codeHash": "868ef79a8cf02a92f2722a70af7155e3f5dbe28353ebdd9f610b3a1e5e662242"
  },
  {
    "seatId": "E-069",
    "classCode": "E",
    "seatIndex": 69,
    "codeHash": "ecbde825c59444c9ee50ae68c0d3fbcd63f7ccb22f0a1a399a054da956f6d0f4"
  },
  {
    "seatId": "E-070",
    "classCode": "E",
    "seatIndex": 70,
    "codeHash": "be4fbb8340d26c93785a588e477e152195a0d7692dac5b3bd4e6f2ec43495c84"
  },
  {
    "seatId": "E-071",
    "classCode": "E",
    "seatIndex": 71,
    "codeHash": "477235ce81e615c3e1d188b56d3bc1ae0bba1befee5bd844c45efaa91842e0ec"
  },
  {
    "seatId": "E-072",
    "classCode": "E",
    "seatIndex": 72,
    "codeHash": "62abe62c8b5e7504a7c4e4389a03287c54ee83b2de06ec277e36c273c8fc3c03"
  },
  {
    "seatId": "E-073",
    "classCode": "E",
    "seatIndex": 73,
    "codeHash": "a9372ea4d4dd47bc135326e3c3e1b6920ac2bf07a663e4a26925c2b036337b64"
  },
  {
    "seatId": "E-074",
    "classCode": "E",
    "seatIndex": 74,
    "codeHash": "f904942f421b4f01dd2e122ff89a06d5b6741da5fb6a4403d8c063463b79bc31"
  },
  {
    "seatId": "E-075",
    "classCode": "E",
    "seatIndex": 75,
    "codeHash": "a3a92c9ca3ad6207c9268751abbc785382923dca14d42ff332eefb115147048a"
  },
  {
    "seatId": "E-076",
    "classCode": "E",
    "seatIndex": 76,
    "codeHash": "f878a6717aeb7dec415bb4e05be3d6bcd2a14968809ff15709815f3178271550"
  },
  {
    "seatId": "E-077",
    "classCode": "E",
    "seatIndex": 77,
    "codeHash": "ee614399300683c9f44d07e2854f2653e901310894454af6f1dc65019801193b"
  },
  {
    "seatId": "E-078",
    "classCode": "E",
    "seatIndex": 78,
    "codeHash": "0742cb73813914571d778fe3e2e5163c435560b42a39332b641e3a3cd1b6663b"
  },
  {
    "seatId": "E-079",
    "classCode": "E",
    "seatIndex": 79,
    "codeHash": "0abe8be751822c9b21dcf62faf2a2c8df6e0463c22644992ed8ab76947c82881"
  },
  {
    "seatId": "E-080",
    "classCode": "E",
    "seatIndex": 80,
    "codeHash": "009adbb4fdd06bab93de8180a8b74fd3d5e53f5860bc85723fb9f4a8bc68a50e"
  },
  {
    "seatId": "E-081",
    "classCode": "E",
    "seatIndex": 81,
    "codeHash": "4a24721e0afec7ef1d508c3af8c7206e45e009afb0a3bb764e565ce99d4c81ee"
  },
  {
    "seatId": "E-082",
    "classCode": "E",
    "seatIndex": 82,
    "codeHash": "303bbe138b1a161bcdb1f16ceb0b9368f9de95af7b38c5ef2c41aef5526ac997"
  },
  {
    "seatId": "E-083",
    "classCode": "E",
    "seatIndex": 83,
    "codeHash": "6129b6cd3106b119daadbc535e7838a47d79ccd8d394e427e74cbc223b69ed7c"
  },
  {
    "seatId": "E-084",
    "classCode": "E",
    "seatIndex": 84,
    "codeHash": "8d4f142c2c3e9b2cac9a3725e228d777757c4fbec44499712c3d27eedc2bc946"
  },
  {
    "seatId": "E-085",
    "classCode": "E",
    "seatIndex": 85,
    "codeHash": "43e75c8aaddf5190d0a9039d9174e6197e77227e3b8bb1eabfaf706349670f22"
  },
  {
    "seatId": "E-086",
    "classCode": "E",
    "seatIndex": 86,
    "codeHash": "f424faad8290396485a91dd2fb78a833855c318353c24fd4cf837ac2ffc0f479"
  },
  {
    "seatId": "E-087",
    "classCode": "E",
    "seatIndex": 87,
    "codeHash": "395ba3bea78635ae4277de9cb69ed293a2e4124a21dfa522f8d604e9bda7424b"
  },
  {
    "seatId": "E-088",
    "classCode": "E",
    "seatIndex": 88,
    "codeHash": "c252b759620845cd13a1b18174b3e1e89975a469947431bc277ecb137a571397"
  },
  {
    "seatId": "E-089",
    "classCode": "E",
    "seatIndex": 89,
    "codeHash": "bfcbf8d21d5cf483c61e219fe0be17bfe776a4645e719901449166c67d5b7aca"
  },
  {
    "seatId": "E-090",
    "classCode": "E",
    "seatIndex": 90,
    "codeHash": "4a542a267f42651295948b728154cecb8bbd0c5e1fd952de00a8fcc32fca6898"
  },
  {
    "seatId": "E-091",
    "classCode": "E",
    "seatIndex": 91,
    "codeHash": "1c8e8219d8e6cc4cc27facf67c11309f94e4892434563e40ccb39879656d2e2a"
  },
  {
    "seatId": "E-092",
    "classCode": "E",
    "seatIndex": 92,
    "codeHash": "44d9aebf1c4a0f7c97078acf7acfe8bc64ddaf97cd857c6d25796d73b118b05c"
  },
  {
    "seatId": "E-093",
    "classCode": "E",
    "seatIndex": 93,
    "codeHash": "21a2be1a2184abccb2045ff91b2a5a88ac4cd3c44a306abf9f9b6509d83e261f"
  },
  {
    "seatId": "E-094",
    "classCode": "E",
    "seatIndex": 94,
    "codeHash": "8ab7e2e6b677293a35dab1bc51433fbb4f6c326c225a197f47c5c23e1a17663a"
  },
  {
    "seatId": "E-095",
    "classCode": "E",
    "seatIndex": 95,
    "codeHash": "2c00a8d7c7a0488ac22541f36affc0046c8041cb52767a08fb862bc709d8b253"
  },
  {
    "seatId": "E-096",
    "classCode": "E",
    "seatIndex": 96,
    "codeHash": "def3a1343aeb9b17d79a2df102e5c2fab0d7b8cc15dc431c61b616aa1a0116a8"
  },
  {
    "seatId": "E-097",
    "classCode": "E",
    "seatIndex": 97,
    "codeHash": "d4ded6bc90483ff47eb40aacb270c5f05b8e9c66c75eeb6f18d2e6ffb388ef12"
  },
  {
    "seatId": "E-098",
    "classCode": "E",
    "seatIndex": 98,
    "codeHash": "f17127c487b2e921da8c33ccf0ec05b964fd6d3ac1c0a48199c640d277ba2e83"
  },
  {
    "seatId": "E-099",
    "classCode": "E",
    "seatIndex": 99,
    "codeHash": "42c0904c9c54bd898d5ac640b086d2fa4bad1ada90f273b44fae8d5ba7541e8a"
  },
  {
    "seatId": "E-100",
    "classCode": "E",
    "seatIndex": 100,
    "codeHash": "76cf08e43ff98d8a5d24d180a12ccd41d7b8aab1564a2cc2ae10373b8efed54f"
  },
  {
    "seatId": "E-101",
    "classCode": "E",
    "seatIndex": 101,
    "codeHash": "6c2ae09f3dbb3043b58e462d1b5eda8d53c98c184ec08300e0a652a519eb9a8a"
  },
  {
    "seatId": "E-102",
    "classCode": "E",
    "seatIndex": 102,
    "codeHash": "c3c0b7fc03beec9de1297347ac40b13dff86897f42eac0e4b453e461f0142653"
  },
  {
    "seatId": "E-103",
    "classCode": "E",
    "seatIndex": 103,
    "codeHash": "d7d8170fa3712d4eac47f39b862fe4708ae59ede90be873d3a9ddf9f0998fa7e"
  },
  {
    "seatId": "E-104",
    "classCode": "E",
    "seatIndex": 104,
    "codeHash": "12ca7143ae734c29d7caf85535d881398b02abba8e420c96006cc6baf2307d2a"
  },
  {
    "seatId": "E-105",
    "classCode": "E",
    "seatIndex": 105,
    "codeHash": "b4f6c7d1df35c630747054a4a78d65391c852a6459a5b0c3660b53d783fd8d8e"
  },
  {
    "seatId": "E-106",
    "classCode": "E",
    "seatIndex": 106,
    "codeHash": "f20a548094768344e128918f145cc09dc5b8f03add1948bbc7634f8f238614aa"
  },
  {
    "seatId": "E-107",
    "classCode": "E",
    "seatIndex": 107,
    "codeHash": "5d798ece6e45809369ad8523625def7a4f0699105a017f7344796a3f3590a4b6"
  },
  {
    "seatId": "E-108",
    "classCode": "E",
    "seatIndex": 108,
    "codeHash": "144f91e90b78840f5b1fe9f1dde9b5c5a4954fbea22968c4d549d95db1db8718"
  },
  {
    "seatId": "E-109",
    "classCode": "E",
    "seatIndex": 109,
    "codeHash": "967f243214894b998cf0c51f1e1072ce892fc4d27467b33ab457d8664d881f05"
  },
  {
    "seatId": "E-110",
    "classCode": "E",
    "seatIndex": 110,
    "codeHash": "f725c15c1dc24e6cddea51aaebc27737ec4b9ddd759cfef57e92e81ada56ea76"
  },
  {
    "seatId": "E-111",
    "classCode": "E",
    "seatIndex": 111,
    "codeHash": "c29e6d8911a780ac82fecc836626c5d1b986eb12a3d5ca646923813d0b5e2410"
  },
  {
    "seatId": "E-112",
    "classCode": "E",
    "seatIndex": 112,
    "codeHash": "4bb90d92d3826f4b96b85617bcaf1f7fa296a494535050883d193d7817ef0c65"
  },
  {
    "seatId": "E-113",
    "classCode": "E",
    "seatIndex": 113,
    "codeHash": "78986e82be954b72b7be92231d1d8e9ecb42714faea5b655a8fe07c7b6e85319"
  },
  {
    "seatId": "E-114",
    "classCode": "E",
    "seatIndex": 114,
    "codeHash": "d513bc51f3df9ae3175d4751270fb17e03bd5cb4418af407800e263f32d50eb0"
  },
  {
    "seatId": "E-115",
    "classCode": "E",
    "seatIndex": 115,
    "codeHash": "1d8ece7315188768f53968a7c27fe908c732c23718554119ec9fe4e267372020"
  },
  {
    "seatId": "E-116",
    "classCode": "E",
    "seatIndex": 116,
    "codeHash": "0f89f39cc93dc45ad0fc49aeb20f6337c44b77d0974f6d9c723e227adb770283"
  },
  {
    "seatId": "E-117",
    "classCode": "E",
    "seatIndex": 117,
    "codeHash": "43be8dec10febae5c9653a4224e3d6e1b64460e04dc37cfd85c192b57c1b48d2"
  },
  {
    "seatId": "E-118",
    "classCode": "E",
    "seatIndex": 118,
    "codeHash": "35cbebfc3fa468c69d9f039407b16441ee27d30d72f895d99167711b067b59e7"
  },
  {
    "seatId": "E-119",
    "classCode": "E",
    "seatIndex": 119,
    "codeHash": "6be2bfab6c4ddb1c2979c781623080d465c2920c371c66c16d6c6d1bf22c106e"
  },
  {
    "seatId": "E-120",
    "classCode": "E",
    "seatIndex": 120,
    "codeHash": "4103b30aaeadb84f3eab23e137edfb91b75f553411a45cb0a5795f66fff77690"
  },
  {
    "seatId": "E-121",
    "classCode": "E",
    "seatIndex": 121,
    "codeHash": "6a4061c0a0ea1c70c48f18822fbc818615d5d55a0066265ccb12b8755b5a6963"
  },
  {
    "seatId": "E-122",
    "classCode": "E",
    "seatIndex": 122,
    "codeHash": "b3601400f894eb699e815c6dfeffa7d1507a6bb845400a6e6515e32d6fcebcb4"
  },
  {
    "seatId": "E-123",
    "classCode": "E",
    "seatIndex": 123,
    "codeHash": "72c25deafb1471113b62ebd52a1d25adee01dbaded948953a1d57093bb1f751c"
  },
  {
    "seatId": "E-124",
    "classCode": "E",
    "seatIndex": 124,
    "codeHash": "7c4f0a8119a8fd2413c565635a9b9229883e4023e3da4359dd27983c3d6c0578"
  },
  {
    "seatId": "E-125",
    "classCode": "E",
    "seatIndex": 125,
    "codeHash": "ba9aa6f14d68486b4d810a26d15c0d2463ac3430b8c568f5f12dbddcf12d6e39"
  },
  {
    "seatId": "E-126",
    "classCode": "E",
    "seatIndex": 126,
    "codeHash": "d2d534bb071f2147c9d6f64437915cf98c7ccb93d247340ab8998a6d02c09ecf"
  },
  {
    "seatId": "E-127",
    "classCode": "E",
    "seatIndex": 127,
    "codeHash": "31088466ee94bce8efc685d22f9073f21dc691bdf2e00fd6363e46dc3b05a3b5"
  },
  {
    "seatId": "E-128",
    "classCode": "E",
    "seatIndex": 128,
    "codeHash": "1fb4a44bc1eebc0c0ef58cf77309882e9e8a8159895a8d1a82572ae58457db8e"
  },
  {
    "seatId": "E-129",
    "classCode": "E",
    "seatIndex": 129,
    "codeHash": "a011ea87f926b29848ee45351c008fb407da1e972c680d685dd69ae550d08da6"
  },
  {
    "seatId": "E-130",
    "classCode": "E",
    "seatIndex": 130,
    "codeHash": "3a94a78aa33a352125d136a4776ed3b238e61fd15837f0bfc7487acce63511b0"
  },
  {
    "seatId": "E-131",
    "classCode": "E",
    "seatIndex": 131,
    "codeHash": "a488ee60a608a529d633cc516972db7e2f5eb51af4bdf893607115271bf8b542"
  },
  {
    "seatId": "E-132",
    "classCode": "E",
    "seatIndex": 132,
    "codeHash": "ba2d9c7d6711e09f03e389dc9d01369e2a365244bcbb4bbd336ab4d9d490c2f3"
  },
  {
    "seatId": "E-133",
    "classCode": "E",
    "seatIndex": 133,
    "codeHash": "03e69888642956e33936756110d50ec11d3c864c11b1fd8cdd3f93d779c6838b"
  },
  {
    "seatId": "E-134",
    "classCode": "E",
    "seatIndex": 134,
    "codeHash": "810a75ee2a508cec5762d88bfc40901fe66554142ef62a54a672cd690fa1f5a5"
  },
  {
    "seatId": "E-135",
    "classCode": "E",
    "seatIndex": 135,
    "codeHash": "b7d6ac63b894135b8d346fc2b3519bd33cd0f9fa188a9fc49b0c79eb71fdfda4"
  },
  {
    "seatId": "E-136",
    "classCode": "E",
    "seatIndex": 136,
    "codeHash": "7f7e38fb4df97bdd4ed6baa33bce2763c3b18a29ee41864c6117119c46721e59"
  },
  {
    "seatId": "E-137",
    "classCode": "E",
    "seatIndex": 137,
    "codeHash": "7117568b99219ec4634bcb44abf4c495ecac20fc4ff285e5aa337eb005df9d42"
  },
  {
    "seatId": "E-138",
    "classCode": "E",
    "seatIndex": 138,
    "codeHash": "94957340928fbdd68721f714d72d619f9a52ae8783effa45b684edd9ca6e2413"
  },
  {
    "seatId": "E-139",
    "classCode": "E",
    "seatIndex": 139,
    "codeHash": "71d0a6287b344411082b3d410777f8b61ccc1088b8e01846695cd4cc168d943d"
  },
  {
    "seatId": "E-140",
    "classCode": "E",
    "seatIndex": 140,
    "codeHash": "1773fe06c833e67fead084454b671045a4cfd6729a680816a8f79288abc58599"
  },
  {
    "seatId": "E-141",
    "classCode": "E",
    "seatIndex": 141,
    "codeHash": "84de74df17e76fac5ee45324c8bf1a3d7150e5f02eed1e14421218ada1b4b2af"
  },
  {
    "seatId": "E-142",
    "classCode": "E",
    "seatIndex": 142,
    "codeHash": "d9490cb8cdb6d2852200022862a32a64e19f998f76ceea5184d118f7ef1cd45c"
  },
  {
    "seatId": "E-143",
    "classCode": "E",
    "seatIndex": 143,
    "codeHash": "d9647846896c2d007917c15c259598fd9f999e8824fe13480bf65b4e78918940"
  },
  {
    "seatId": "E-144",
    "classCode": "E",
    "seatIndex": 144,
    "codeHash": "1d4c68bf0203519de6fca819aa2cf7f827b0e732d77c1a54e363162583d9975b"
  },
  {
    "seatId": "E-145",
    "classCode": "E",
    "seatIndex": 145,
    "codeHash": "1a0a4b049b3e9498d10124c9aa9ac45624fa23820fa1419e1664ce0c1204b104"
  },
  {
    "seatId": "E-146",
    "classCode": "E",
    "seatIndex": 146,
    "codeHash": "b0c9238661ff05ea433eb4b9f9e99aed3b12202cdb3aa4076c8d2cf761159efa"
  },
  {
    "seatId": "E-147",
    "classCode": "E",
    "seatIndex": 147,
    "codeHash": "55a0253c1264454a66db332b4497b9ece42681ef27233311f9b3073597eba5fb"
  },
  {
    "seatId": "E-148",
    "classCode": "E",
    "seatIndex": 148,
    "codeHash": "373be9cfc0396a5e8f92d1dabe8a4de0e318f01dc6ff834ff181be5fb9d92507"
  },
  {
    "seatId": "E-149",
    "classCode": "E",
    "seatIndex": 149,
    "codeHash": "e97fab748e7848e65ec4bff17f2a80df9d6bc47e06f10728f5149abdb9616601"
  },
  {
    "seatId": "E-150",
    "classCode": "E",
    "seatIndex": 150,
    "codeHash": "9abbf06fc8c5ec737adc40276fbf566b189036fe71416c465117d5ec8d1a5e66"
  },
  {
    "seatId": "E-151",
    "classCode": "E",
    "seatIndex": 151,
    "codeHash": "86076f9b5f810e3c564d257e2991e3834f55aa85dc0a2cc140d59a5d5c7a0720"
  },
  {
    "seatId": "E-152",
    "classCode": "E",
    "seatIndex": 152,
    "codeHash": "348e02e7ceeb34964bc3654bb4ac785ecc361268268b3998dfd2353996ca4438"
  },
  {
    "seatId": "E-153",
    "classCode": "E",
    "seatIndex": 153,
    "codeHash": "b2cbc4d6d3adb2c7c11066f3a376919c4a7824e4668570a7ec02112be4d8f33d"
  },
  {
    "seatId": "E-154",
    "classCode": "E",
    "seatIndex": 154,
    "codeHash": "6d376242de81eb81f8aca1017cf52e114c88db7e09a033f4841983f182b9844c"
  },
  {
    "seatId": "E-155",
    "classCode": "E",
    "seatIndex": 155,
    "codeHash": "c7910085b979a5f412e41d6b14bc959858aca089efb46887a530ed9691472886"
  },
  {
    "seatId": "E-156",
    "classCode": "E",
    "seatIndex": 156,
    "codeHash": "50d5cf198b0e83914aed31625b452846358bd335aa46d239693faeeef60b6066"
  },
  {
    "seatId": "E-157",
    "classCode": "E",
    "seatIndex": 157,
    "codeHash": "39c6b47715202bce97fe0c377212e1c7c3ee558d97dc1f848ec0c4092b9e6cb5"
  },
  {
    "seatId": "E-158",
    "classCode": "E",
    "seatIndex": 158,
    "codeHash": "27931ef78c5e7768b3f269b7fe5414a2199cf359b0411515942b82011bebef00"
  },
  {
    "seatId": "E-159",
    "classCode": "E",
    "seatIndex": 159,
    "codeHash": "a61fc389afffdbb8e82f4fcdcdb693db8ae557bcea5feb9d5300b590b7892576"
  },
  {
    "seatId": "E-160",
    "classCode": "E",
    "seatIndex": 160,
    "codeHash": "1086b406820c5a7862ecd7a97b84f65d29809d164c79e2e59bc00cf45b0a3d03"
  },
  {
    "seatId": "F-001",
    "classCode": "F",
    "seatIndex": 1,
    "codeHash": "a660bcc24819986b029783362be2d09c67a580b5a1c785d08c00df8a10181007"
  },
  {
    "seatId": "F-002",
    "classCode": "F",
    "seatIndex": 2,
    "codeHash": "fafb1ff1bd81f8b306490472b1ca0c82d59c93cea6100d45fde6055ee0233c06"
  },
  {
    "seatId": "F-003",
    "classCode": "F",
    "seatIndex": 3,
    "codeHash": "f1a50d084fbff6ae888a74bbc287015d9fd6c337757092f69b50dce7fcf38ff5"
  },
  {
    "seatId": "F-004",
    "classCode": "F",
    "seatIndex": 4,
    "codeHash": "b9321ee46830e4ea69d8f424ff78bca7e0ed60651ad46ace4542b178baaffd2f"
  },
  {
    "seatId": "F-005",
    "classCode": "F",
    "seatIndex": 5,
    "codeHash": "d255fac8f7b51b85d721f2a90b2fe4a860fc20a97cb5d9d35a9a529971994a5c"
  },
  {
    "seatId": "F-006",
    "classCode": "F",
    "seatIndex": 6,
    "codeHash": "0437f4d40640235bea5a09a5574650b1e4088f1f84acd04a55500a8b2bdcbd9b"
  },
  {
    "seatId": "F-007",
    "classCode": "F",
    "seatIndex": 7,
    "codeHash": "5c60590d9d4026192ec86174e0519bc318fcf1c71fb851f9540f0b88c0221184"
  },
  {
    "seatId": "F-008",
    "classCode": "F",
    "seatIndex": 8,
    "codeHash": "833c49731c6493393f6a0a1ad661da7edc5fccebe8bdf048d244deac976f2ea4"
  },
  {
    "seatId": "F-009",
    "classCode": "F",
    "seatIndex": 9,
    "codeHash": "bdefe89ffc7ab926dc1214a99cde3e7bf5331a7932cda1d5664e83e2cf7c2e6e"
  },
  {
    "seatId": "F-010",
    "classCode": "F",
    "seatIndex": 10,
    "codeHash": "26a146cd93c2161b538e09c402849eda547c73350f3975629b924ec0ec4fdaf0"
  },
  {
    "seatId": "F-011",
    "classCode": "F",
    "seatIndex": 11,
    "codeHash": "c6e2d665187569a60675fbb863ca8cd65833e87a773d9d6d8faaaf49d7142df9"
  },
  {
    "seatId": "F-012",
    "classCode": "F",
    "seatIndex": 12,
    "codeHash": "abd39558c5b4b0d38fce8e003373e9de586eca5519cd9dc0f2fac6d93dede1c1"
  },
  {
    "seatId": "F-013",
    "classCode": "F",
    "seatIndex": 13,
    "codeHash": "cd0596bc3d03be1441b6f22806ff16287dd346ab8e4f6027f16ec7ae27f97808"
  },
  {
    "seatId": "F-014",
    "classCode": "F",
    "seatIndex": 14,
    "codeHash": "68c4ca4768f331a3e8912ec5120bd34b4bb2af6d270280861a015bff9cac9c2c"
  },
  {
    "seatId": "F-015",
    "classCode": "F",
    "seatIndex": 15,
    "codeHash": "3b8929f4104e68629d1ceaffef262c8e9f56888137498c8765336bc154342281"
  },
  {
    "seatId": "F-016",
    "classCode": "F",
    "seatIndex": 16,
    "codeHash": "d79f283408457096731dc836b3aa8c87e765442fae27886e47ac96b51b4a7a68"
  },
  {
    "seatId": "F-017",
    "classCode": "F",
    "seatIndex": 17,
    "codeHash": "7dcd21fc0a47b6a7ffbfef77663965a9e82ab69184a266f27e1eaa3899eedff3"
  },
  {
    "seatId": "F-018",
    "classCode": "F",
    "seatIndex": 18,
    "codeHash": "10dbeb62c67c27af6e5ecef3db1320d0b4e20b666a27a031791e21cedc06de9f"
  },
  {
    "seatId": "F-019",
    "classCode": "F",
    "seatIndex": 19,
    "codeHash": "623e822e5b6d1446fdc301f5441b995a9f9a3d9d3517318a8504c4875f81276e"
  },
  {
    "seatId": "F-020",
    "classCode": "F",
    "seatIndex": 20,
    "codeHash": "cf3e70e86cc35a7d615e34832dc94f6b4936e870026b69781581578a5a4354c8"
  },
  {
    "seatId": "F-021",
    "classCode": "F",
    "seatIndex": 21,
    "codeHash": "29b3ced0d4bc89f84c387b8130f08ada68e2637de88659f62d3f40890b821bdf"
  },
  {
    "seatId": "F-022",
    "classCode": "F",
    "seatIndex": 22,
    "codeHash": "89ce8ddba1447b71942d67acabd31f86e616cfe3d542aa84f261d544cfa4cf1b"
  },
  {
    "seatId": "F-023",
    "classCode": "F",
    "seatIndex": 23,
    "codeHash": "165f61d098531a39903200558b78d0ae05dbf87f6bccb9e7778250a9e6fd0d23"
  },
  {
    "seatId": "F-024",
    "classCode": "F",
    "seatIndex": 24,
    "codeHash": "6e1cf3df652f89f1eafcea143e65c2d7d5fcb75b0e5764c0e7f499f33adca1d4"
  },
  {
    "seatId": "F-025",
    "classCode": "F",
    "seatIndex": 25,
    "codeHash": "84fb5692d0e4e9f0704d94ae94d28326c2356497c7ed3ecd4c17f0eb49807f89"
  },
  {
    "seatId": "F-026",
    "classCode": "F",
    "seatIndex": 26,
    "codeHash": "672414c8e88e7d992225d340e2ddecc3c272ff1507b07e66bbdd32ec261a95f9"
  },
  {
    "seatId": "F-027",
    "classCode": "F",
    "seatIndex": 27,
    "codeHash": "deb344f76799a625426346439141fa1df4fa35afde6695bb2f02d58191a5cfa6"
  },
  {
    "seatId": "F-028",
    "classCode": "F",
    "seatIndex": 28,
    "codeHash": "4e50ac5ccd101b17e2012de274a3f0938869aa4d56485bb8516c8d02fdfea262"
  },
  {
    "seatId": "F-029",
    "classCode": "F",
    "seatIndex": 29,
    "codeHash": "b26e8043c10d30157f560887d06c7f0c8955268cecb3eeb81eb636b7152051de"
  },
  {
    "seatId": "F-030",
    "classCode": "F",
    "seatIndex": 30,
    "codeHash": "53cefbb3b4991fd524832f191e3908931530b817839d49a14011d2e761899b31"
  },
  {
    "seatId": "F-031",
    "classCode": "F",
    "seatIndex": 31,
    "codeHash": "f0d198f610db5754574aa8315c920fee054020db12404dff8495330fa88c8e0b"
  },
  {
    "seatId": "F-032",
    "classCode": "F",
    "seatIndex": 32,
    "codeHash": "3a10b3e6f11c269dde35b49421ad4fadbe793ba95edcdda460910d28a2bfe8ce"
  },
  {
    "seatId": "F-033",
    "classCode": "F",
    "seatIndex": 33,
    "codeHash": "c2eb8d106debdae0901cbf5ded8336aaabcfeaf79f019d5d3796ffe2c1124ee9"
  },
  {
    "seatId": "F-034",
    "classCode": "F",
    "seatIndex": 34,
    "codeHash": "0dc90b94f78d2f8405422484d4ba0055b5f97a33912232525106cb5cbd4f532f"
  },
  {
    "seatId": "F-035",
    "classCode": "F",
    "seatIndex": 35,
    "codeHash": "8bc29fc620db43d3288be1e49a039b94e1f519cc77ee4283feedfe8f1dba6982"
  },
  {
    "seatId": "F-036",
    "classCode": "F",
    "seatIndex": 36,
    "codeHash": "baf7bb167987f4dbc2d3b4412f08e835b892f3618dc99e332abcb580481c2abc"
  },
  {
    "seatId": "F-037",
    "classCode": "F",
    "seatIndex": 37,
    "codeHash": "8a7c69272033520d47243f52f5cd276e0bcb4ca15664145eafe9c59698f2e898"
  },
  {
    "seatId": "F-038",
    "classCode": "F",
    "seatIndex": 38,
    "codeHash": "e53bf7e191890acbbfeea34fc3050ebf98c0ea8a127db2ccb0a80f83da886e93"
  },
  {
    "seatId": "F-039",
    "classCode": "F",
    "seatIndex": 39,
    "codeHash": "f50751266c152ec03c0cd42529db5d1d5d423843eb2c1f24501670fe58cb081a"
  },
  {
    "seatId": "F-040",
    "classCode": "F",
    "seatIndex": 40,
    "codeHash": "722233cb577f24c7adde46c2d291fcb62a76960613d7d68d5816b4900ed3f1ac"
  },
  {
    "seatId": "F-041",
    "classCode": "F",
    "seatIndex": 41,
    "codeHash": "4e1291051aa8254d5ef85064b1e6ee691d2ba820de4da6f6c887fe82909874e6"
  },
  {
    "seatId": "F-042",
    "classCode": "F",
    "seatIndex": 42,
    "codeHash": "51c08bd19caf1d4f06a9c8c1e0fede5a28b4934a38a6e71fd088602d6d20eed1"
  },
  {
    "seatId": "F-043",
    "classCode": "F",
    "seatIndex": 43,
    "codeHash": "eae8e943938763711da0860bfffb80e8016e1e36174aff0af6feda25e93494d8"
  },
  {
    "seatId": "F-044",
    "classCode": "F",
    "seatIndex": 44,
    "codeHash": "9e421f67dc619cb26a022948c1f0ee9e1dcee7543ca72e5ce9d4e39e66d32169"
  },
  {
    "seatId": "F-045",
    "classCode": "F",
    "seatIndex": 45,
    "codeHash": "caa7a5c321acb105db16a5a511c30d059ecd0311f59e9a89bb16413483e12184"
  },
  {
    "seatId": "F-046",
    "classCode": "F",
    "seatIndex": 46,
    "codeHash": "1a66433864408fcc6d020417e4b3a73a8ef56d1baeb38b65e0cee60de1f15a3c"
  },
  {
    "seatId": "F-047",
    "classCode": "F",
    "seatIndex": 47,
    "codeHash": "0273764cc2e22663b922ae6b938892d648f046862fb3b52f6aace23ad4c820c4"
  },
  {
    "seatId": "F-048",
    "classCode": "F",
    "seatIndex": 48,
    "codeHash": "ae771e6ac673df70f04d59d24891059f425dfb50a2002713d8d32ba1f876a5e2"
  },
  {
    "seatId": "F-049",
    "classCode": "F",
    "seatIndex": 49,
    "codeHash": "b066c823aaeb2e731b6a207924ac72eb86e68af7cc003d3a79973e7f1b565662"
  },
  {
    "seatId": "F-050",
    "classCode": "F",
    "seatIndex": 50,
    "codeHash": "83dcb38a31243413e055e10b8682dda0448406fba4ffe5062ab9a6e30f46b995"
  },
  {
    "seatId": "F-051",
    "classCode": "F",
    "seatIndex": 51,
    "codeHash": "05fde9a21a0ce68b04b2c665a20920e9bc3785a9da5da30a5a105bdf4a461b3b"
  },
  {
    "seatId": "F-052",
    "classCode": "F",
    "seatIndex": 52,
    "codeHash": "f1431e503c7662f4696595a3023e5b944aa731570e82ba31e822fd1a052cbbca"
  },
  {
    "seatId": "F-053",
    "classCode": "F",
    "seatIndex": 53,
    "codeHash": "c21e305ba9532a6d016754d8b633b514a51db882e83044d2e146d046e93fade3"
  },
  {
    "seatId": "F-054",
    "classCode": "F",
    "seatIndex": 54,
    "codeHash": "8897ec6e484e11ae952f24e14d88c9943f85f56a989d8c6f3bd3c6fcaef21f1a"
  },
  {
    "seatId": "F-055",
    "classCode": "F",
    "seatIndex": 55,
    "codeHash": "d0c7dfc02069ec6d0cba7a3b389105e5f31760e78116e543d7dd56eaf785143e"
  },
  {
    "seatId": "F-056",
    "classCode": "F",
    "seatIndex": 56,
    "codeHash": "f7d47f3f56820e164edeeecb557450e38aef72d15d0289ded94415d59bc2d710"
  },
  {
    "seatId": "F-057",
    "classCode": "F",
    "seatIndex": 57,
    "codeHash": "94906db25ab513846d83fa5955854d95881d93e8ca01b37fc039482dd2399bd7"
  },
  {
    "seatId": "F-058",
    "classCode": "F",
    "seatIndex": 58,
    "codeHash": "5460f0cde3a8f6c5b556ef3e1b7d42325a55080878fd7d0285c5a94b8c9dad49"
  },
  {
    "seatId": "F-059",
    "classCode": "F",
    "seatIndex": 59,
    "codeHash": "2b5cd6cd2a5ad0d9563bece7e22d4e5b285f20318bdc1839a45c745dc3ee90e8"
  },
  {
    "seatId": "F-060",
    "classCode": "F",
    "seatIndex": 60,
    "codeHash": "4db12c0ae6a2e029b04a817257c23f08690321110ce96e073f0b02c00703b0d1"
  },
  {
    "seatId": "F-061",
    "classCode": "F",
    "seatIndex": 61,
    "codeHash": "32b2be70c7604b86979eebbef8019d81fea54c1805c3adbc89b716d5a8eea451"
  },
  {
    "seatId": "F-062",
    "classCode": "F",
    "seatIndex": 62,
    "codeHash": "a6eb2d245a3d1a020a73177fd21252f404ea02aa30a925bd0f17113d8b78cd48"
  },
  {
    "seatId": "F-063",
    "classCode": "F",
    "seatIndex": 63,
    "codeHash": "8f963ce3a7b1ff42194190e9c8dffd60b94662988f2063e922ac4830cf42067a"
  },
  {
    "seatId": "F-064",
    "classCode": "F",
    "seatIndex": 64,
    "codeHash": "53fb13bde0406c9d8c6b67e716d012977c9e4628ec5a41bd9b59959e9ec88d5c"
  },
  {
    "seatId": "F-065",
    "classCode": "F",
    "seatIndex": 65,
    "codeHash": "450acb9e49f2802aab0f733349b742d50e60cf23cbd413945458027b2b6dc7cc"
  },
  {
    "seatId": "F-066",
    "classCode": "F",
    "seatIndex": 66,
    "codeHash": "2f096d856b09d9ac826cec8efcbf82d87668b48d38fd7e5d64f85c754318195b"
  },
  {
    "seatId": "F-067",
    "classCode": "F",
    "seatIndex": 67,
    "codeHash": "27352792a37dfa2ff56b2c758f011c0d42d91a8145ea759e45d36e88c6baaf3e"
  },
  {
    "seatId": "F-068",
    "classCode": "F",
    "seatIndex": 68,
    "codeHash": "fcf744e9c98aa095e64f9cb9c89dcdf20a18c386254c635abaa68e1c63726eb9"
  },
  {
    "seatId": "F-069",
    "classCode": "F",
    "seatIndex": 69,
    "codeHash": "6f645abd0d9b58a1811908ddd0221f5ecd35ccd6d94823ae6e94aa964018649b"
  },
  {
    "seatId": "F-070",
    "classCode": "F",
    "seatIndex": 70,
    "codeHash": "8afb5b65ad58f0891d9e3ebd1b794147e6dc79dfc0ca29460bb87e400a649dc0"
  },
  {
    "seatId": "F-071",
    "classCode": "F",
    "seatIndex": 71,
    "codeHash": "3c092abcfb01c8b07ce4a2e0688c8090aeabb03e59c32248ad5c374269132e6f"
  },
  {
    "seatId": "F-072",
    "classCode": "F",
    "seatIndex": 72,
    "codeHash": "3b5c1de1742b96538b1cd6912163a7ecce9947db2d04dfff9270e925ed9955da"
  },
  {
    "seatId": "F-073",
    "classCode": "F",
    "seatIndex": 73,
    "codeHash": "609342dc449c1dd23b755cd553834b7138fb47a5e69620de48a37100f7cedc94"
  },
  {
    "seatId": "F-074",
    "classCode": "F",
    "seatIndex": 74,
    "codeHash": "eff9782fb35d9ca22f357530d9982d40cff988772f979317871cff23ed17f4e7"
  },
  {
    "seatId": "F-075",
    "classCode": "F",
    "seatIndex": 75,
    "codeHash": "be23adc9c4f628280dba2e325fb0b1e12fd9ce8bdde07ff53e3b72e5f42eec0a"
  },
  {
    "seatId": "F-076",
    "classCode": "F",
    "seatIndex": 76,
    "codeHash": "0b8d987c6b0b4dc47586f7cfa50478dff9b3e0ad10afa9363a1096a23ba2b405"
  },
  {
    "seatId": "F-077",
    "classCode": "F",
    "seatIndex": 77,
    "codeHash": "cfb7c37f23d924de88b0c8c2d519c7580fab4c414d2014306ccbdea3f4c6a492"
  },
  {
    "seatId": "F-078",
    "classCode": "F",
    "seatIndex": 78,
    "codeHash": "69659d99b5359fae3072930ea9ad7eeaa6e6a34744e07ceb4d099bf8674a4f95"
  },
  {
    "seatId": "F-079",
    "classCode": "F",
    "seatIndex": 79,
    "codeHash": "0395232e230edf955a29a057ff2735881b6fd76f46cfeefca18982e701d35d04"
  },
  {
    "seatId": "F-080",
    "classCode": "F",
    "seatIndex": 80,
    "codeHash": "f08d2ded262fb225e77dada5f24ac878080e605c0a42578f40100939e7737d43"
  },
  {
    "seatId": "F-081",
    "classCode": "F",
    "seatIndex": 81,
    "codeHash": "0edd0135d4788a1b857e0db95e656dd1e9a81a72126ce8bad7b813dbf9ab60e4"
  },
  {
    "seatId": "F-082",
    "classCode": "F",
    "seatIndex": 82,
    "codeHash": "d76f492b304c23cd7f5732349fa429603f66f0d6db555923bb47835770370ceb"
  },
  {
    "seatId": "F-083",
    "classCode": "F",
    "seatIndex": 83,
    "codeHash": "0b34bb5214c4973c18e09786a9c7f3616478c1e71c05c6eca094f917b7a17e9f"
  },
  {
    "seatId": "F-084",
    "classCode": "F",
    "seatIndex": 84,
    "codeHash": "3e862e1dc0b816eee7f131e2bee9143a5516ba73be4ec5a7297a63404a87e36d"
  },
  {
    "seatId": "F-085",
    "classCode": "F",
    "seatIndex": 85,
    "codeHash": "65340756d0bf9ce0b5e3731fd4374a30dd767289e2459a038f3826f9bf07920f"
  },
  {
    "seatId": "F-086",
    "classCode": "F",
    "seatIndex": 86,
    "codeHash": "529ce98b02e6b7324da47d50c470ece74a30bcbf915168308f337bf7dbebfbb9"
  },
  {
    "seatId": "F-087",
    "classCode": "F",
    "seatIndex": 87,
    "codeHash": "2460d08a943ecb4a1a6728839df808302234df59f47d956adf25de5c1de8327a"
  },
  {
    "seatId": "F-088",
    "classCode": "F",
    "seatIndex": 88,
    "codeHash": "43f28b320a564031331b233304dc6d4f068ecea0d5940dbb4d57a1843b84ae7c"
  },
  {
    "seatId": "F-089",
    "classCode": "F",
    "seatIndex": 89,
    "codeHash": "11a07568a201c8002ca9af86c9703f2077d6cf02f110366f69ddfe71721e4ec5"
  },
  {
    "seatId": "F-090",
    "classCode": "F",
    "seatIndex": 90,
    "codeHash": "05f36f72dd3d67885bb7a7833e76d255faf0b130ccf3751464311641e181378f"
  },
  {
    "seatId": "F-091",
    "classCode": "F",
    "seatIndex": 91,
    "codeHash": "dd743847b37a25e3e9f8c339e0aa28253529062a01ce19f7675f5765724faed0"
  },
  {
    "seatId": "F-092",
    "classCode": "F",
    "seatIndex": 92,
    "codeHash": "feffb6621ba10b53a5b8bf9db80e1fe4fd1a3be4fbe4d9dd462313feae143b52"
  },
  {
    "seatId": "F-093",
    "classCode": "F",
    "seatIndex": 93,
    "codeHash": "db2bc9e8f690c69e2e9baa7cb0aa45fb7fb76dd8943964f1d66e6a045ad1c6ea"
  },
  {
    "seatId": "F-094",
    "classCode": "F",
    "seatIndex": 94,
    "codeHash": "b0222c192ab6deadb5a1bf3a83eccf0291621989dc778d22be4c8f687048cad2"
  },
  {
    "seatId": "F-095",
    "classCode": "F",
    "seatIndex": 95,
    "codeHash": "92e5b39e975de46e4b0eea18c52f7d35e5edbbab07d0b8bd3201f5ab611bb8f9"
  },
  {
    "seatId": "F-096",
    "classCode": "F",
    "seatIndex": 96,
    "codeHash": "f0e1fc6f08f857f15cf1b103ade290cc3a6207dbb497c989a97beb7e9f687ab8"
  },
  {
    "seatId": "F-097",
    "classCode": "F",
    "seatIndex": 97,
    "codeHash": "82fbb6ab4677c2ec47adc2aab4bf795d5e076fdfeeb08b02a52a52b248abcf73"
  },
  {
    "seatId": "F-098",
    "classCode": "F",
    "seatIndex": 98,
    "codeHash": "c2657b2165fcbb1c3da7a2451544c6a080656dde05adece0ef89f045fbf49f42"
  },
  {
    "seatId": "F-099",
    "classCode": "F",
    "seatIndex": 99,
    "codeHash": "033d1ee310eddb3758ce439929653e995afc4866ada5999769a6c82c0804d0db"
  },
  {
    "seatId": "F-100",
    "classCode": "F",
    "seatIndex": 100,
    "codeHash": "43ef2e1b03502ddfec819f437cd4ed4c83f8115c3082c0ea8840c57c8dcec606"
  },
  {
    "seatId": "F-101",
    "classCode": "F",
    "seatIndex": 101,
    "codeHash": "a189f24020cc6384b319efb0ea56ac77e3ee83422531c48782dfdd1f5a011a2d"
  },
  {
    "seatId": "F-102",
    "classCode": "F",
    "seatIndex": 102,
    "codeHash": "af26ea9a4a547f3630356c0f0dc6a4f447f5d1a8a436a69a33d7b2e39479bf1e"
  },
  {
    "seatId": "F-103",
    "classCode": "F",
    "seatIndex": 103,
    "codeHash": "a357f4c0f23e2bbe42ab2a48668730e037195a2ae641b4928020383f58ac9175"
  },
  {
    "seatId": "F-104",
    "classCode": "F",
    "seatIndex": 104,
    "codeHash": "b1f856a3c4e180573ed4ddb20548993186e2e9ff43c2d6675f11fd8e2912250e"
  },
  {
    "seatId": "F-105",
    "classCode": "F",
    "seatIndex": 105,
    "codeHash": "94d85324445fc3904d9cad4e6d5a1b0e62aa757fa41a159a39761f04cc5fda01"
  },
  {
    "seatId": "F-106",
    "classCode": "F",
    "seatIndex": 106,
    "codeHash": "dc075c33e5a67a4c25c1d8e37b89d01ff54f725580da679aadba32bcc5809072"
  },
  {
    "seatId": "F-107",
    "classCode": "F",
    "seatIndex": 107,
    "codeHash": "193080d61a85746b34c2f44070f09b904daed1b385ae10215795818a6d1a1b97"
  },
  {
    "seatId": "F-108",
    "classCode": "F",
    "seatIndex": 108,
    "codeHash": "1cf3397accef3cdcd3ef4d22de8f36c55c744b058e23eeb1ddeaac421f2a4ff5"
  },
  {
    "seatId": "F-109",
    "classCode": "F",
    "seatIndex": 109,
    "codeHash": "ce24ec2df93a72e98aa67cf4a76733f85e535c3d443a4a04ad48361263049f0e"
  },
  {
    "seatId": "F-110",
    "classCode": "F",
    "seatIndex": 110,
    "codeHash": "2a954a88a022638b795d1c3918dc2c017f33766905d380892394e444324d0d5c"
  },
  {
    "seatId": "F-111",
    "classCode": "F",
    "seatIndex": 111,
    "codeHash": "5ddb38cd99db6a3aa7bb52527021a6aafca4c7d3efe47440fbf16a9c43a2fec5"
  },
  {
    "seatId": "F-112",
    "classCode": "F",
    "seatIndex": 112,
    "codeHash": "c208575db14ec5a8ec9750cb11553f26542e95d1deb88503f05edfe95a8b4039"
  },
  {
    "seatId": "F-113",
    "classCode": "F",
    "seatIndex": 113,
    "codeHash": "78d35a9031405fba65d331dfc7e982081ec5acebc780ba27ea3146b9ea95be43"
  },
  {
    "seatId": "F-114",
    "classCode": "F",
    "seatIndex": 114,
    "codeHash": "2b739d377be40a2f6ac86ca20056bfa25912b5c21acf7aa795869b489d37f6cd"
  },
  {
    "seatId": "F-115",
    "classCode": "F",
    "seatIndex": 115,
    "codeHash": "54952a0175db28dc781d4f093617afa9ed4492bbc3762322dfb78766d214052e"
  },
  {
    "seatId": "F-116",
    "classCode": "F",
    "seatIndex": 116,
    "codeHash": "7de333e835213685ca92c9348d04a36e252bdba7f7554a8d28d6ec0d86302088"
  },
  {
    "seatId": "F-117",
    "classCode": "F",
    "seatIndex": 117,
    "codeHash": "4b3f6bee751d8d93bb90243f4187a557d0bf1dd788c15fc54654a2b792f7ca9f"
  },
  {
    "seatId": "F-118",
    "classCode": "F",
    "seatIndex": 118,
    "codeHash": "f0cc63ef7fb5ea6918d9fb5513d5760ff204f49237076ed3c31813c7432fc9c5"
  },
  {
    "seatId": "F-119",
    "classCode": "F",
    "seatIndex": 119,
    "codeHash": "76ed39d5aaa2ec2fdfd514a4d1cf97922c1b41192ef4f62cfd7da46efeea23d8"
  },
  {
    "seatId": "F-120",
    "classCode": "F",
    "seatIndex": 120,
    "codeHash": "2b601efd8eadc34efb0936569b3a3047b7057d27f26861bfbf57d2fb26768f5f"
  },
  {
    "seatId": "F-121",
    "classCode": "F",
    "seatIndex": 121,
    "codeHash": "29a2b357802bc88321d964bf1b914d67401e0c86e7a647638f06bf45b06ada67"
  },
  {
    "seatId": "F-122",
    "classCode": "F",
    "seatIndex": 122,
    "codeHash": "b67187cac4b0a780174afb00ef31646570facdd13174d55350126c9bb454f94e"
  },
  {
    "seatId": "F-123",
    "classCode": "F",
    "seatIndex": 123,
    "codeHash": "933c16ad226e19231d7f9eb560a8f7192df26a632b4659c92e050c4637ce1560"
  },
  {
    "seatId": "F-124",
    "classCode": "F",
    "seatIndex": 124,
    "codeHash": "72832a182c188216ae9fe7f38baed429427d5af3b9dacea3834809e8a29e7730"
  },
  {
    "seatId": "F-125",
    "classCode": "F",
    "seatIndex": 125,
    "codeHash": "5e2bfce0441036fa6d723d32965eeb8a24c72379630e954a7fa001e74c7ace98"
  },
  {
    "seatId": "F-126",
    "classCode": "F",
    "seatIndex": 126,
    "codeHash": "b0306307c0b836a0a68064530b95af5cb3d77d1f46023977f44264761ba41a79"
  },
  {
    "seatId": "F-127",
    "classCode": "F",
    "seatIndex": 127,
    "codeHash": "61d6cc28ff90d834a98b8fdd8ae9c25413858fdcde1b48cb59451a0570a56a54"
  },
  {
    "seatId": "F-128",
    "classCode": "F",
    "seatIndex": 128,
    "codeHash": "b25e43806d7de96bd31c12817ee2bf1a3e60a71772596e55047b925f148c4889"
  },
  {
    "seatId": "F-129",
    "classCode": "F",
    "seatIndex": 129,
    "codeHash": "bf33f271454c7673c39c096946fbb3e5299a6c744ece9cce20eec1e844896c8d"
  },
  {
    "seatId": "F-130",
    "classCode": "F",
    "seatIndex": 130,
    "codeHash": "f273ac3010e424a058ec8e59316f5e81e6101a2d9252e38bd41f121857fa977b"
  },
  {
    "seatId": "F-131",
    "classCode": "F",
    "seatIndex": 131,
    "codeHash": "46610dbc91111bea6ace243a90956596f7254d00a23409ce5842bc24ad0a2367"
  },
  {
    "seatId": "F-132",
    "classCode": "F",
    "seatIndex": 132,
    "codeHash": "1ae9d5ff6326f7eebd909b861d2ee565adaa1e5e988ace9528ae3ed51375238a"
  },
  {
    "seatId": "F-133",
    "classCode": "F",
    "seatIndex": 133,
    "codeHash": "fd30fb5750e63b9636df4a06c2fcd4742976b0b441ef6650c5de6564762adc14"
  },
  {
    "seatId": "F-134",
    "classCode": "F",
    "seatIndex": 134,
    "codeHash": "5d1e92f78d6a188a76e119cbe4b4e2f341da36270c27c5e7da4b888892c4ca9d"
  },
  {
    "seatId": "F-135",
    "classCode": "F",
    "seatIndex": 135,
    "codeHash": "9ce45948ee402e9f4ea0c462242413089a105b4422e394089cc5372d0ca08ec2"
  },
  {
    "seatId": "F-136",
    "classCode": "F",
    "seatIndex": 136,
    "codeHash": "5c7360244305288641a9f6de2dbd6bd95b6e4305631f55e9ea4b05e7d6d63907"
  },
  {
    "seatId": "F-137",
    "classCode": "F",
    "seatIndex": 137,
    "codeHash": "1eaf2e420cccd557c18d9ee364dfb6b05e1c358180b98ddc14c652ed4b4a5d6e"
  },
  {
    "seatId": "F-138",
    "classCode": "F",
    "seatIndex": 138,
    "codeHash": "49a82ffbc2c51306bfd8806f2aa4877176cccda70ccb72dddd05738e3e9f9850"
  },
  {
    "seatId": "F-139",
    "classCode": "F",
    "seatIndex": 139,
    "codeHash": "0c7ad7e7e10d57a7ee763ad14364510ea2fdcd44d91826e154f098225a85c828"
  },
  {
    "seatId": "F-140",
    "classCode": "F",
    "seatIndex": 140,
    "codeHash": "e1f9f37efc6612252a6e21b5043bd3446c2e98e71a9e64bb93dde51fff9cfd77"
  },
  {
    "seatId": "F-141",
    "classCode": "F",
    "seatIndex": 141,
    "codeHash": "ecfc7ac03960f5c16e1bd8e888513d547f8fa5f5902f3c27887ac3a29d4f21ba"
  },
  {
    "seatId": "F-142",
    "classCode": "F",
    "seatIndex": 142,
    "codeHash": "196c7f100274f98d6708e80a4eab389d1237d6d69eec46a061e454cdb4326bae"
  },
  {
    "seatId": "F-143",
    "classCode": "F",
    "seatIndex": 143,
    "codeHash": "0674f44e166927b30727b941ca699df77af051bb99c5be6d583ce2ff9a26d67e"
  },
  {
    "seatId": "F-144",
    "classCode": "F",
    "seatIndex": 144,
    "codeHash": "7e080c5bd8720d578190a9a6da08dfdabd0d4f188689fc37c51053ce9222c88f"
  }
] as const satisfies readonly AnchorCodeCommitment[];

// The steward anchor-reserve wallet (fresh for the public launch). At GENESIS it owns ALL 512 anchor
// positions and the backing ZIR; positions are transferred out to chosen owners later.
export const MAINNET_ANCHOR_STEWARD: Address = "zir1zms84nsnv6svzycpmqa5fperfzwmgmn4xkqu6u";

/** True when a seat is part of its class genesis-reserved half (lower seat indices). The reserved half
 * carries 2x the website allocation; the open half carries 1x. Split is exactly half per class. */
export function isReservedAnchorSeat(classCode: AnchorClass, seatIndex: number): boolean {
  return seatIndex <= ANCHOR_CLASSES[classCode].seats / 2;
}

/** The µZIR allocation a seat carries, derived from its class and whether it is in the reserved half. */
export function anchorSeatAllocationUZIR(classCode: AnchorClass, seatIndex: number): number {
  return anchorPositionAllocationUZIR(classCode, isReservedAnchorSeat(classCode, seatIndex));
}

/** Genesis ownership: the steward wallet owns every one of the 512 positions at launch. Derived from
 * the public code commitments so seat ids/classes stay in lockstep with the registry. */
export const DEFAULT_MAINNET_ANCHOR_OWNERSHIP: readonly AnchorGenesisOwnership[] =
  DEFAULT_ANCHOR_CODE_COMMITMENTS.map((c) => ({ seatId: c.seatId, owner: MAINNET_ANCHOR_STEWARD }));

/**
 * Reconciliation audit for the per-position allocation model. Sums the reserved half (2x) and open half
 * (1x) over all classes and compares against the 30% anchor reserve. Pure/deterministic; used by tests.
 */
export const ANCHOR_ALLOCATION_AUDIT = (() => {
  let reservedSeats = 0, openSeats = 0, reservedUZIR = 0, openUZIR = 0;
  for (const code of Object.keys(ANCHOR_CLASSES) as AnchorClass[]) {
    const meta = ANCHOR_CLASSES[code];
    for (let seatIndex = 1; seatIndex <= meta.seats; seatIndex++) {
      const reserved = isReservedAnchorSeat(code, seatIndex);
      const alloc = anchorPositionAllocationUZIR(code, reserved);
      if (reserved) { reservedSeats++; reservedUZIR += alloc; }
      else { openSeats++; openUZIR += alloc; }
    }
  }
  const totalUZIR = reservedUZIR + openUZIR;
  return {
    reservedSeats, openSeats, totalSeats: reservedSeats + openSeats,
    reservedUZIR, openUZIR, totalUZIR,
    reserveUZIR: PROTOCOL.ANCHOR_RESERVE_UZIR,
    bufferUZIR: PROTOCOL.ANCHOR_RESERVE_UZIR - totalUZIR,
  };
})();

void TOTAL_ANCHOR_SEATS; void ANCHOR_POSITION_ZIR_1X;

