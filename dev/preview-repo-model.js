window.__VSG_REPO_MODEL = {
 "repoName": "MedicusNet",
 "root": "E:\\Razvoj\\MedicusStack\\MedicusNet",
 "refs": [
  {
   "name": "refs/heads/Test_alpha",
   "short": "Test_alpha",
   "kind": "head",
   "hash": "794e7724b919517cfc8fadba430778ed1e74ab16",
   "upstream": "origin/Test_alpha",
   "current": true
  },
  {
   "name": "refs/heads/Insurance_Specifications_Rewrite",
   "short": "Insurance_Specifications_Rewrite",
   "kind": "head",
   "hash": "8aadc524528a0a42868af89a90e53bd336a6d82f",
   "current": false
  },
  {
   "name": "refs/heads/NSKZZ-Demo",
   "short": "NSKZZ-Demo",
   "kind": "head",
   "hash": "71c503279e7ec60df02893a99b746fe75015ad33",
   "current": false
  },
  {
   "name": "refs/heads/NSKZZ-RC",
   "short": "NSKZZ-RC",
   "kind": "head",
   "hash": "2941fa151f1400f9e5ab350eaf1c823b7e65f51d",
   "current": false
  },
  {
   "name": "refs/remotes/origin/Test_alpha",
   "short": "origin/Test_alpha",
   "kind": "remote",
   "hash": "8129a20562e6ff6e94e7fa009bb704ea81be8aee",
   "current": false
  },
  {
   "name": "refs/heads/master",
   "short": "master",
   "kind": "head",
   "hash": "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208",
   "current": false
  },
  {
   "name": "refs/remotes/origin/Insurance_Specifications_Rewrite",
   "short": "origin/Insurance_Specifications_Rewrite",
   "kind": "remote",
   "hash": "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208",
   "current": false
  },
  {
   "name": "refs/remotes/origin/NSKZZ-Demo",
   "short": "origin/NSKZZ-Demo",
   "kind": "remote",
   "hash": "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208",
   "current": false
  },
  {
   "name": "refs/remotes/origin/NSKZZ-RC",
   "short": "origin/NSKZZ-RC",
   "kind": "remote",
   "hash": "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208",
   "current": false
  },
  {
   "name": "refs/remotes/origin/master",
   "short": "origin/master",
   "kind": "remote",
   "hash": "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208",
   "current": false
  },
  {
   "name": "refs/tags/v1.0",
   "short": "v1.0",
   "kind": "tag",
   "hash": "6e51efab27631b7e1b7b326c46c8f6a5534448eb",
   "current": false
  }
 ],
 "graph": {
  "rows": [
   {
    "commit": {
     "hash": "794e7724b919517cfc8fadba430778ed1e74ab16",
     "shortHash": "794e772",
     "parents": [
      "487e7451591ec96967515a0e56b2c3430ff59aef",
      "2941fa151f1400f9e5ab350eaf1c823b7e65f51d"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:52:13+02:00",
     "subject": "Merge branch 'NSKZZ-RC' into Test_alpha",
     "refs": [
      "HEAD -> Test_alpha"
     ]
    },
    "lane": 0,
    "color": 0,
    "above": [],
    "below": [
     {
      "lane": 0,
      "color": 0
     },
     {
      "lane": 1,
      "color": 1
     }
    ],
    "through": [],
    "laneCount": 2,
    "group": "local",
    "outgoing": true,
    "isHead": true
   },
   {
    "commit": {
     "hash": "487e7451591ec96967515a0e56b2c3430ff59aef",
     "shortHash": "487e745",
     "parents": [
      "484aadaeee209ee136e0815decb7ce2c4cac7fc1",
      "8aadc524528a0a42868af89a90e53bd336a6d82f"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:52:12+02:00",
     "subject": "Merge branch 'NSKZZ-Demo' into Test_alpha",
     "refs": []
    },
    "lane": 0,
    "color": 0,
    "above": [
     {
      "lane": 0,
      "color": 0
     }
    ],
    "below": [
     {
      "lane": 0,
      "color": 0
     },
     {
      "lane": 2,
      "color": 2
     }
    ],
    "through": [
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 3,
    "group": "local",
    "outgoing": true,
    "isHead": false
   },
   {
    "commit": {
     "hash": "2941fa151f1400f9e5ab350eaf1c823b7e65f51d",
     "shortHash": "2941fa1",
     "parents": [
      "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:51:42+02:00",
     "subject": "RC: widen the settings view",
     "refs": [
      "NSKZZ-RC"
     ]
    },
    "lane": 1,
    "color": 1,
    "above": [
     {
      "lane": 1,
      "color": 1
     }
    ],
    "below": [
     {
      "lane": 1,
      "color": 1
     }
    ],
    "through": [
     {
      "from": 0,
      "to": 0,
      "color": 0
     },
     {
      "from": 2,
      "to": 2,
      "color": 2
     }
    ],
    "laneCount": 3,
    "group": "local",
    "outgoing": true,
    "isHead": false
   },
   {
    "commit": {
     "hash": "8aadc524528a0a42868af89a90e53bd336a6d82f",
     "shortHash": "8aadc52",
     "parents": [
      "5224d9dfe4c98e32dd2b26069edebb34a61472eb"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:51:42+02:00",
     "subject": "Insurance: map specifications to the context",
     "refs": [
      "Insurance_Specifications_Rewrite"
     ]
    },
    "lane": 2,
    "color": 2,
    "above": [
     {
      "lane": 2,
      "color": 2
     }
    ],
    "below": [
     {
      "lane": 2,
      "color": 2
     }
    ],
    "through": [
     {
      "from": 0,
      "to": 0,
      "color": 0
     },
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 3,
    "group": "local",
    "outgoing": true,
    "isHead": false
   },
   {
    "commit": {
     "hash": "5224d9dfe4c98e32dd2b26069edebb34a61472eb",
     "shortHash": "5224d9d",
     "parents": [
      "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:51:42+02:00",
     "subject": "Insurance: specification table shape",
     "refs": []
    },
    "lane": 2,
    "color": 2,
    "above": [
     {
      "lane": 2,
      "color": 2
     }
    ],
    "below": [
     {
      "lane": 1,
      "color": 1
     }
    ],
    "through": [
     {
      "from": 0,
      "to": 0,
      "color": 0
     },
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 3,
    "group": "local",
    "outgoing": true,
    "isHead": false
   },
   {
    "commit": {
     "hash": "8129a20562e6ff6e94e7fa009bb704ea81be8aee",
     "shortHash": "8129a20",
     "parents": [
      "1b8f9247ea52f63b35042aa71dae08b32a2065b9"
     ],
     "author": "Other",
     "date": "2026-09-11T10:48:56+02:00",
     "subject": "Bump the spa package version",
     "refs": [
      "origin/Test_alpha"
     ]
    },
    "lane": 2,
    "color": 3,
    "above": [],
    "below": [
     {
      "lane": 2,
      "color": 3
     }
    ],
    "through": [
     {
      "from": 0,
      "to": 0,
      "color": 0
     },
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 3,
    "group": "incoming",
    "outgoing": false,
    "isHead": false
   },
   {
    "commit": {
     "hash": "1b8f9247ea52f63b35042aa71dae08b32a2065b9",
     "shortHash": "1b8f924",
     "parents": [
      "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208"
     ],
     "author": "Other",
     "date": "2026-09-11T10:48:56+02:00",
     "subject": "DbContext: index the widget settings table",
     "refs": []
    },
    "lane": 2,
    "color": 3,
    "above": [
     {
      "lane": 2,
      "color": 3
     }
    ],
    "below": [
     {
      "lane": 1,
      "color": 1
     }
    ],
    "through": [
     {
      "from": 0,
      "to": 0,
      "color": 0
     },
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 3,
    "group": "incoming",
    "outgoing": false,
    "isHead": false
   },
   {
    "commit": {
     "hash": "484aadaeee209ee136e0815decb7ce2c4cac7fc1",
     "shortHash": "484aada",
     "parents": [
      "03367ae812b46b10d0bf6b04a987eb5f8d84a2b8"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:48:55+02:00",
     "subject": "Constants: add the export feature flag",
     "refs": []
    },
    "lane": 0,
    "color": 0,
    "above": [
     {
      "lane": 0,
      "color": 0
     }
    ],
    "below": [
     {
      "lane": 0,
      "color": 0
     }
    ],
    "through": [
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 2,
    "group": "local",
    "outgoing": true,
    "isHead": false
   },
   {
    "commit": {
     "hash": "03367ae812b46b10d0bf6b04a987eb5f8d84a2b8",
     "shortHash": "03367ae",
     "parents": [
      "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208"
     ],
     "author": "Demo",
     "date": "2026-09-11T10:48:55+02:00",
     "subject": "Widget settings controller accepts a tenant id",
     "refs": []
    },
    "lane": 0,
    "color": 0,
    "above": [
     {
      "lane": 0,
      "color": 0
     }
    ],
    "below": [
     {
      "lane": 1,
      "color": 1
     }
    ],
    "through": [
     {
      "from": 1,
      "to": 1,
      "color": 1
     }
    ],
    "laneCount": 2,
    "group": "local",
    "outgoing": true,
    "isHead": false
   },
   {
    "commit": {
     "hash": "90cd6cc37a87f77dcd7bf688bd66f1571fdb7208",
     "shortHash": "90cd6cc",
     "parents": [],
     "author": "Demo",
     "date": "2026-09-11T10:38:50+02:00",
     "subject": "Initial project layout",
     "refs": [
      "tag: v1.0",
      "origin/master",
      "origin/NSKZZ-RC",
      "origin/NSKZZ-Demo",
      "origin/Insurance_Specifications_Rewrite",
      "master"
     ]
    },
    "lane": 1,
    "color": 1,
    "above": [
     {
      "lane": 1,
      "color": 1
     }
    ],
    "below": [],
    "through": [],
    "laneCount": 2,
    "group": "local",
    "outgoing": false,
    "isHead": false
   }
  ],
  "maxLanes": 3,
  "incoming": 2,
  "outgoing": 7,
  "hasMore": false,
  "scope": "Test_alpha",
  "upstream": "origin/Test_alpha"
 }
};
