## ADDED Requirements

### Requirement: Auto-capture detects credentials at capture time

The auto-capture pipeline SHALL check message text for credential patterns (API keys, tokens, passwords, private keys) before storing a memory. When a credential is detected, the memory SHALL be stored with `quarantined: true` and `trustScore: 0.0`. This check SHALL use the same `detectCredential()` function used by the sleep cycle credential scan phase.

#### Scenario: API key in user message is quarantined immediately

- **WHEN** a user message containing "my key is sk-ant-api03-abc123..." passes the attention gate
- **AND** auto-capture processes the message
- **THEN** the memory SHALL be stored with `quarantined: true` and `trustScore: 0.0`
- **AND** the memory SHALL NOT appear in default `memory_recall` results
- **AND** a warning SHALL be logged indicating credential detection

#### Scenario: Bearer token in message is quarantined immediately

- **WHEN** a user message containing "Authorization: Bearer eyJhbGci..." passes the attention gate
- **AND** auto-capture processes the message
- **THEN** the memory SHALL be stored with `quarantined: true` and `trustScore: 0.0`

#### Scenario: Normal message without credentials is stored normally

- **WHEN** a user message containing "The deployment went well and we hit our latency targets" passes the attention gate
- **AND** auto-capture processes the message
- **THEN** the memory SHALL be stored with default `trustScore: 1.0` and no `quarantined` flag

#### Scenario: Credential detection does not block auto-capture pipeline

- **WHEN** the `detectCredential()` function throws an unexpected error
- **THEN** the auto-capture pipeline SHALL continue and store the memory normally
- **AND** the error SHALL be logged at debug level
