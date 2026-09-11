// Generated for the design preview. The conflict rows and the in-progress
// merge are synthesized; everything else came from a real repository.
window.__VSG_MODEL = {
 "repos": [
  {
   "root": "C:/Users/franj/AppData/Local/Temp/claude/d--DungeonKeeperRemake-Codex/9e327231-9d19-4800-a917-eac06d5154ae/scratchpad/demo",
   "name": "MedicusNet"
  }
 ],
 "separator": "\\",
 "canGenerateMessage": true,
 "active": {
  "root": "C:/Users/franj/AppData/Local/Temp/claude/d--DungeonKeeperRemake-Codex/9e327231-9d19-4800-a917-eac06d5154ae/scratchpad/demo",
  "name": "demo",
  "branch": "Test_alpha",
  "detached": false,
  "branches": [
   "Test_alpha",
   "Insurance_Specifications_Rewrite",
   "NSKZZ-Demo",
   "NSKZZ-RC",
   "master"
  ],
  "upstream": "origin/Test_alpha",
  "ahead": 7,
  "behind": 2,
  "staged": [
   {
    "path": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsEndpoint.cs",
    "origPath": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsController.cs",
    "status": "renamed",
    "staged": true
   },
   {
    "path": "Mcs.Skzz.Data/Entities/WidgetSetting.cs",
    "status": "modified",
    "staged": true
   },
   {
    "path": "Mcs.Skzz.Data/Repositories/WidgetSettingRepository.cs",
    "status": "modified",
    "staged": true
   }
  ],
  "unstaged": [
   {
    "path": "Mcs.Medicus.Spa/src/app/shared/widget-settings.component.html",
    "status": "modified",
    "staged": false
   },
   {
    "path": "Mcs.Medicus.Spa/src/app/shared/widget-settings.component.ts",
    "status": "modified",
    "staged": false
   },
   {
    "path": "Mcs.Medicus.Spa/src/styles/theme.scss",
    "status": "modified",
    "staged": false
   },
   {
    "path": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsValidator.cs",
    "status": "untracked",
    "staged": false
   },
   {
    "path": "Mcs.Skzz.Common/Extensions/StringExtensions.cs",
    "status": "modified",
    "staged": false
   },
   {
    "path": "Mcs.Skzz.Data/Entities/WidgetSetting.cs",
    "status": "modified",
    "staged": false
   },
   {
    "path": "Mcs.Skzz.Database/Migrations/20260911_AddWidgetSettings.sql",
    "status": "modified",
    "staged": false
   },
   {
    "path": "Mcs.Skzz.Database/Views/vw_WidgetSettings.sql",
    "status": "modified",
    "staged": false
   }
  ],
  "conflicts": [
   {
    "path": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsController.cs",
    "status": "conflict",
    "staged": false
   },
   {
    "path": "Mcs.Skzz.Common/Constants.cs",
    "status": "conflict",
    "staged": false
   }
  ],
  "operation": {
   "kind": "merge",
   "ref": "Insurance_Specifications_Rewrite"
  },
  "stashes": [
   {
    "index": 0,
    "label": "On master: wip"
   },
   {
    "index": 1,
    "label": "On master: tenant-export phase 0 + phase 1 (code + sql, no docs)"
   },
   {
    "index": 2,
    "label": "On master: planovi"
   }
  ],
  "unstagedTree": [
   {
    "kind": "folder",
    "key": "Mcs.Medicus.Spa/src",
    "label": "Mcs.Medicus.Spa\\src",
    "children": [
     {
      "kind": "folder",
      "key": "Mcs.Medicus.Spa/src/app/shared",
      "label": "app\\shared",
      "children": [
       {
        "kind": "file",
        "key": "Mcs.Medicus.Spa/src/app/shared/widget-settings.component.html",
        "label": "widget-settings.component.html",
        "change": {
         "path": "Mcs.Medicus.Spa/src/app/shared/widget-settings.component.html",
         "status": "modified",
         "staged": false
        }
       },
       {
        "kind": "file",
        "key": "Mcs.Medicus.Spa/src/app/shared/widget-settings.component.ts",
        "label": "widget-settings.component.ts",
        "change": {
         "path": "Mcs.Medicus.Spa/src/app/shared/widget-settings.component.ts",
         "status": "modified",
         "staged": false
        }
       }
      ],
      "fileCount": 2
     },
     {
      "kind": "folder",
      "key": "Mcs.Medicus.Spa/src/styles",
      "label": "styles",
      "children": [
       {
        "kind": "file",
        "key": "Mcs.Medicus.Spa/src/styles/theme.scss",
        "label": "theme.scss",
        "change": {
         "path": "Mcs.Medicus.Spa/src/styles/theme.scss",
         "status": "modified",
         "staged": false
        }
       }
      ],
      "fileCount": 1
     }
    ],
    "fileCount": 3
   },
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings",
    "label": "Mcs.Skzz.Api\\Controllers\\Api\\WidgetSettings",
    "children": [
     {
      "kind": "file",
      "key": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsValidator.cs",
      "label": "WidgetSettingsValidator.cs",
      "change": {
       "path": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsValidator.cs",
       "status": "untracked",
       "staged": false
      }
     }
    ],
    "fileCount": 1
   },
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Common/Extensions",
    "label": "Mcs.Skzz.Common\\Extensions",
    "children": [
     {
      "kind": "file",
      "key": "Mcs.Skzz.Common/Extensions/StringExtensions.cs",
      "label": "StringExtensions.cs",
      "change": {
       "path": "Mcs.Skzz.Common/Extensions/StringExtensions.cs",
       "status": "modified",
       "staged": false
      }
     }
    ],
    "fileCount": 1
   },
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Data/Entities",
    "label": "Mcs.Skzz.Data\\Entities",
    "children": [
     {
      "kind": "file",
      "key": "Mcs.Skzz.Data/Entities/WidgetSetting.cs",
      "label": "WidgetSetting.cs",
      "change": {
       "path": "Mcs.Skzz.Data/Entities/WidgetSetting.cs",
       "status": "modified",
       "staged": false
      }
     }
    ],
    "fileCount": 1
   },
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Database",
    "label": "Mcs.Skzz.Database",
    "children": [
     {
      "kind": "folder",
      "key": "Mcs.Skzz.Database/Migrations",
      "label": "Migrations",
      "children": [
       {
        "kind": "file",
        "key": "Mcs.Skzz.Database/Migrations/20260911_AddWidgetSettings.sql",
        "label": "20260911_AddWidgetSettings.sql",
        "change": {
         "path": "Mcs.Skzz.Database/Migrations/20260911_AddWidgetSettings.sql",
         "status": "modified",
         "staged": false
        }
       }
      ],
      "fileCount": 1
     },
     {
      "kind": "folder",
      "key": "Mcs.Skzz.Database/Views",
      "label": "Views",
      "children": [
       {
        "kind": "file",
        "key": "Mcs.Skzz.Database/Views/vw_WidgetSettings.sql",
        "label": "vw_WidgetSettings.sql",
        "change": {
         "path": "Mcs.Skzz.Database/Views/vw_WidgetSettings.sql",
         "status": "modified",
         "staged": false
        }
       }
      ],
      "fileCount": 1
     }
    ],
    "fileCount": 2
   }
  ],
  "stagedTree": [
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings",
    "label": "Mcs.Skzz.Api\\Controllers\\Api\\WidgetSettings",
    "children": [
     {
      "kind": "file",
      "key": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsEndpoint.cs",
      "label": "WidgetSettingsEndpoint.cs",
      "change": {
       "path": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsEndpoint.cs",
       "origPath": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsController.cs",
       "status": "renamed",
       "staged": true
      }
     }
    ],
    "fileCount": 1
   },
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Data",
    "label": "Mcs.Skzz.Data",
    "children": [
     {
      "kind": "folder",
      "key": "Mcs.Skzz.Data/Entities",
      "label": "Entities",
      "children": [
       {
        "kind": "file",
        "key": "Mcs.Skzz.Data/Entities/WidgetSetting.cs",
        "label": "WidgetSetting.cs",
        "change": {
         "path": "Mcs.Skzz.Data/Entities/WidgetSetting.cs",
         "status": "modified",
         "staged": true
        }
       }
      ],
      "fileCount": 1
     },
     {
      "kind": "folder",
      "key": "Mcs.Skzz.Data/Repositories",
      "label": "Repositories",
      "children": [
       {
        "kind": "file",
        "key": "Mcs.Skzz.Data/Repositories/WidgetSettingRepository.cs",
        "label": "WidgetSettingRepository.cs",
        "change": {
         "path": "Mcs.Skzz.Data/Repositories/WidgetSettingRepository.cs",
         "status": "modified",
         "staged": true
        }
       }
      ],
      "fileCount": 1
     }
    ],
    "fileCount": 2
   }
  ],
  "conflictsTree": [
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings",
    "label": "Mcs.Skzz.Api\\Controllers\\Api\\WidgetSettings",
    "children": [
     {
      "kind": "file",
      "key": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsController.cs",
      "label": "WidgetSettingsController.cs",
      "change": {
       "path": "Mcs.Skzz.Api/Controllers/Api/WidgetSettings/WidgetSettingsController.cs",
       "status": "conflict",
       "staged": false
      }
     }
    ],
    "fileCount": 1
   },
   {
    "kind": "folder",
    "key": "Mcs.Skzz.Common",
    "label": "Mcs.Skzz.Common",
    "children": [
     {
      "kind": "file",
      "key": "Mcs.Skzz.Common/Constants.cs",
      "label": "Constants.cs",
      "change": {
       "path": "Mcs.Skzz.Common/Constants.cs",
       "status": "conflict",
       "staged": false
      }
     }
    ],
    "fileCount": 1
   }
  ],
  "displayRoot": "E:\\Razvoj\\MedicusStack\\MedicusNet"
 }
};
