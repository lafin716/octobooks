/**
 * 지식베이스 대화 추적 타입.
 * Message.ragTrace 필드 이름은 기존 저장 데이터와 맞추려고 그대로 둔다.
 * 예전 저장본에는 더 많은 필드가 있을 수 있으므로 읽는 쪽은 toolCalls만 믿는다.
 */

/** 한 응답에서 지식베이스 도구를 호출한 횟수 */
export interface KbTrace {
  toolCalls: number;
}
