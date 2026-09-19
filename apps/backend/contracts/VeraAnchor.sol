// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title VeraAnchor
 * @notice VeraWallet 증거 앵커 — 계산 근거(머클루트)·지갑 바인딩·리포트 감사 해시를 OmniOne Chain에 봉인한다.
 *
 * 체인에 올라가는 것은 32바이트 해시 하나뿐이다. 금액·거래 내역·지갑 주소·신원은 절대 여기 오지 않는다
 * (백엔드 `AnchorRecord`에 userId가 없다는 프라이버시 불변식의 온체인 쪽 대응).
 *
 * 왜 컨트랙트인가 — 트랜잭션 calldata에 해시를 실어도 체인에는 남지만, 그 기록은 트랜잭션 해시를
 * 알아야만 찾을 수 있다. 이 컨트랙트는 같은 해시를 (1) 저장소에 키로 넣어 누구나 조회할 수 있게 하고
 * (2) 이벤트로 내보내 "이 계정이 올린 근거 전부"를 로그로 목록화할 수 있게 한다.
 *
 * 함수 시그니처 `anchor(bytes32,string)`은 백엔드 `OmniOneChainAdapter`의 ABI와 정확히 같다 —
 * 주소만 `ANCHOR_CONTRACT_ADDRESS`에 넣으면 코드 변경 없이 이 컨트랙트로 전환된다.
 */
contract VeraAnchor {
    struct Record {
        /// @dev 올린 계정. VeraWallet 서비스 계정이지만, 누구나 자기 해시를 올릴 수 있다.
        address submitter;
        /// @dev 블록 타임스탬프. "언제 고정됐는가"의 증거.
        uint64 anchoredAt;
        /// @dev 블록 번호. 탐색기 없이도 RPC 한 번으로 블록을 찾을 수 있게 남긴다.
        uint64 blockNumber;
        /// @dev 앵커 종류. 백엔드 `AnchorType`과 같은 문자열("rule_version" | "binding" | "audit").
        string anchorType;
    }

    /// @notice payloadHash → 기록. 없는 해시는 submitter가 0 주소다.
    mapping(bytes32 => Record) public anchors;

    /// @notice 지금까지 봉인된 해시 수. 콘솔·탐색기에서 활동량을 한눈에 보기 위한 값.
    uint256 public totalAnchors;

    /**
     * @notice 해시가 봉인될 때마다 한 번.
     * @dev `anchorTypeId = keccak256(bytes(anchorType))`를 따로 indexed로 둔다 — string을 직접 indexed로 하면
     *      로그에 해시만 남아 사람이 읽을 수 없고, indexed가 없으면 종류별 필터(`eth_getLogs` topic)가 안 된다.
     */
    event Anchored(
        bytes32 indexed payloadHash,
        address indexed submitter,
        bytes32 indexed anchorTypeId,
        string anchorType,
        uint256 anchoredAt,
        uint256 blockNumber
    );

    error AlreadyAnchored(bytes32 payloadHash, address submitter, uint64 anchoredAt);
    error EmptyAnchorType();

    /**
     * @notice 해시 하나를 봉인한다. 같은 해시는 두 번 봉인할 수 없다 — 첫 기록의 시각이 유일한 진실이어야
     *         "그때 고정됐다"가 흔들리지 않는다.
     * @param payloadHash 봉인할 32바이트 해시(계산 근거의 머클루트 등).
     * @param anchorType  앵커 종류. 백엔드 `AnchorType`과 같은 문자열.
     */
    function anchor(bytes32 payloadHash, string calldata anchorType) external {
        if (bytes(anchorType).length == 0) revert EmptyAnchorType();
        Record storage existing = anchors[payloadHash];
        if (existing.submitter != address(0)) {
            revert AlreadyAnchored(payloadHash, existing.submitter, existing.anchoredAt);
        }

        anchors[payloadHash] = Record({
            submitter: msg.sender,
            anchoredAt: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            anchorType: anchorType
        });
        totalAnchors += 1;

        emit Anchored(payloadHash, msg.sender, keccak256(bytes(anchorType)), anchorType, block.timestamp, block.number);
    }

    /// @notice 해시가 봉인돼 있는가. 탐색기 없는 환경에서 제3자가 RPC 한 번으로 확인하는 용도.
    function isAnchored(bytes32 payloadHash) external view returns (bool) {
        return anchors[payloadHash].submitter != address(0);
    }
}
