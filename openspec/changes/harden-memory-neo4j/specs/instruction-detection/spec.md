## ADDED Requirements

### Requirement: GLiNER ONNX model integrity verification

The local entity extractor SHALL verify the SHA-256 hash of the downloaded GLiNER ONNX model file against a pinned hash constant. If verification fails, the extractor SHALL log a warning and fall back to regex-only extraction instead of loading the unverified model.

#### Scenario: Model hash matches pinned value

- **WHEN** the GLiNER ONNX model is downloaded or loaded from cache
- **AND** its SHA-256 hash matches `GLINER_MODEL_SHA256`
- **THEN** the model SHALL be loaded normally for NER inference

#### Scenario: Model hash does not match pinned value

- **WHEN** the GLiNER ONNX model is downloaded
- **AND** its SHA-256 hash does NOT match `GLINER_MODEL_SHA256`
- **THEN** the model SHALL NOT be loaded
- **AND** a warning SHALL be logged indicating hash mismatch with expected and actual values
- **AND** the extractor SHALL fall back to regex-only extraction

#### Scenario: Empty hash constant skips verification with warning

- **WHEN** `GLINER_MODEL_SHA256` is set to an empty string
- **THEN** the model SHALL be loaded without hash verification
- **AND** a warning SHALL be logged indicating that integrity verification is disabled
