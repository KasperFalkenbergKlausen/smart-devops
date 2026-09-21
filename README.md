# Azure DevOps Work Item Importer

En lokal webapplikation med en Express/Node.js backend og responsiv frontend til lynhurtig import af Features, User Stories og Tasks til Azure DevOps via REST API.

## Funktioner

- **PAT-baseret godkendelse**: Indtast Personal Access Token direkte i frontend-grænsefladen (logges aldrig på serveren).
- **Hierarkisk import**: Opretter Features $\rightarrow$ User Stories $\rightarrow$ Tasks i én samlet handling med automatiske relationer (`System.LinkTypes.Hierarchy-Reverse`).
- **Eksisterende Feature tilknytning**: Valgfri tilknytning direkte til en eksisterende Feature ved hjælp af Feature ID.
- **Live Hierarkisk Preview**: Parser og visualiserer dit JSON-træ on-the-fly med type-badges og tællere.
- **Direkte ADO-links**: Resultatpanelet viser de oprettede ID'er med direkte links til Azure DevOps.

## Hurtig start

1. Installer afhængigheder:
   ```bash
   npm install
   ```
2. Start serveren:
   ```bash
   npm start
   ```
3. Åbn browseren på:
   [http://localhost:3001](http://localhost:3001) (eller den port serveren logger i terminalen)

## JSON Format

```json
[
  {
    "title": "Test Feature (ignoreres hvis eksisterende ID angives)",
    "description": "Eksempel på feature til test",
    "tags": ["K2-opgradering"],
    "userStories": [
      {
        "title": "Test A",
        "description": "Beskrivelse for User Story Test A",
        "tags": ["K2-opgradering"],
        "tasks": [
          {
            "title": "Task 1",
            "description": "Beskrivelse for Task 1 under Test A",
            "tags": ["K2-opgradering"]
          },
          {
            "title": "Task 2",
            "description": "Beskrivelse for Task 2 under Test A",
            "tags": ["K2-opgradering"]
          }
        ]
      },
      {
        "title": "Test B",
        "description": "Beskrivelse for User Story Test B",
        "tags": ["K2-opgradering"],
        "tasks": [
          {
            "title": "Task 1",
            "description": "Beskrivelse for Task 1 under Test B",
            "tags": ["K2-opgradering"]
          },
          {
            "title": "Task 2",
            "description": "Beskrivelse for Task 2 under Test B",
            "tags": ["K2-opgradering"]
          }
        ]
      }
    ]
  }
]
```