// ================================================
// 만봉프린트 고객 시안 접수 및 이메일 발송 서버
// Cloudflare Pages Functions + Resend
// ================================================

// JSON 응답을 만드는 함수
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

// HTML에 들어가는 고객 입력값을 안전하게 변환
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

// 첨부 파일 이름에 사용할 수 없는 문자 제거
function safeFilename(name = 'image') {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n]/g, '')
    .slice(0, 120);
}

// 파일 데이터를 이메일 첨부용 Base64로 변환
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 0x8000)
    );
  }

  return btoa(binary);
}

// FormData에서 실제 파일인지 확인
function isFile(value) {
  return value &&
    typeof value.arrayBuffer === 'function' &&
    typeof value.size === 'number';
}

// ================================================
// POST /api/send-design
// 고객 정보와 파일을 받아 이메일 발송
// ================================================

export async function onRequestPost({ request, env }) {

  try {

    // 1. 메일 설정 확인
    if (
      !env.RESEND_API_KEY ||
      !env.MAIL_TO ||
      !env.MAIL_FROM
    ) {
      return jsonResponse({
        error: '이메일 발송 환경 설정이 완료되지 않았습니다.'
      }, 500);
    }

    // 2. 고객이 보낸 데이터 읽기
    const form = await request.formData();

    const customerName =
      String(form.get('customerName') || '').trim();

    const phone =
      String(form.get('phone') || '').trim();

    const email =
      String(form.get('email') || '').trim();

    const requestMemo =
      String(form.get('requestMemo') || '').trim();

    const printType =
      String(form.get('printType') || '').trim();

    const quantity =
      String(form.get('quantity') || '').trim();

    const balloonName =
      String(form.get('balloonName') || '').trim();

    // 3. 필수 고객 정보 확인
    if (!customerName || !phone) {
      return jsonResponse({
        error: '고객명과 연락처를 입력해 주세요.'
      }, 400);
    }

    if (
      customerName.length > 100 ||
      phone.length > 40 ||
      email.length > 254 ||
      requestMemo.length > 3000
    ) {
      return jsonResponse({
        error: '입력한 정보가 허용된 길이를 초과했습니다.'
      }, 400);
    }

    // 이메일 입력 시 형식 확인
    if (
      email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse({
        error: '이메일 주소를 확인해 주세요.'
      }, 400);
    }

    // 4. 첨부 파일 목록
    const fileList = [
      {
        key: 'frontLogo',
        label: '앞면 로고 원본',
        required: false
      },
      {
        key: 'backLogo',
        label: '뒷면 로고 원본',
        required: false
      },
      {
        key: 'combinedImage',
        label: '통합 시안 이미지',
        required: true
      }
    ];

    const attachments = [];
    let totalSize = 0;

    // 파일 하나 최대 10MB
    const MAX_FILE_SIZE = 10 * 1024 * 1024;

    // 모든 파일 합계 최대 20MB
    const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

    // 5. 업로드한 파일 확인 및 첨부 준비
    for (const item of fileList) {

      const file = form.get(item.key);

      if (!file) {

        if (item.required) {
          return jsonResponse({
            error: '통합 시안 이미지가 전달되지 않았습니다.'
          }, 400);
        }

        continue;
      }

      if (!isFile(file) || file.size <= 0) {
        return jsonResponse({
          error: '첨부 파일을 확인해 주세요.'
        }, 400);
      }

      // 앞면 및 뒷면 로고는 이미지 파일만 허용
      const allowedTypes =
        item.key === 'combinedImage'
          ? ['image/jpeg']
          : ['image/png', 'image/jpeg', 'image/webp'];

      if (!allowedTypes.includes(file.type)) {
        return jsonResponse({
          error: 'PNG, JPG, JPEG, WEBP 파일만 첨부할 수 있습니다.'
        }, 400);
      }

      // 개별 파일 용량 확인
      if (file.size > MAX_FILE_SIZE) {
        return jsonResponse({
          error: '이미지 파일 하나의 용량은 10MB 이하로 제한됩니다.'
        }, 400);
      }

      totalSize += file.size;

      // 전체 파일 용량 확인
      if (totalSize > MAX_TOTAL_SIZE) {
        return jsonResponse({
          error: '첨부 파일 전체 용량은 20MB 이하로 제한됩니다.'
        }, 400);
      }

      // 원본 파일 내용을 그대로 읽기
      const buffer = await file.arrayBuffer();

      // 이메일 첨부 자료로 변환
      attachments.push({
        filename: safeFilename(file.name || item.label + '.jpg'),
        content: toBase64(buffer),
        content_type: file.type
      });
    }

    // 6. 고객 정보 및 요청사항 이메일 본문 작성
    const quantityText = {
      '100up': '100개 이상',
      '1000up': '1,000개 이상'
    }[quantity] || quantity;

    const html = `
      <div style="font-family:Arial,'Malgun Gothic',sans-serif;line-height:1.7;color:#222;">

        <h2 style="border-bottom:2px solid #333;padding-bottom:12px;">
          만봉프린트 새 시안 접수
        </h2>

        <h3>1. 고객 정보</h3>

        <p>
          <strong>고객명 / 업체명:</strong>
          ${escapeHtml(customerName)}
        </p>

        <p>
          <strong>연락처:</strong>
          ${escapeHtml(phone)}
        </p>

        <p>
          <strong>이메일:</strong>
          ${escapeHtml(email || '미입력')}
        </p>

        <h3>2. 제작 요청 정보</h3>

        <p>
          <strong>인쇄 방식:</strong>
          ${escapeHtml(printType)}
        </p>

        <p>
          <strong>제작 수량:</strong>
          ${escapeHtml(quantityText)}
        </p>

        <p>
          <strong>풍선 색상:</strong>
          ${escapeHtml(balloonName || '미선택')}
        </p>

        <p>
          <strong>고객 요청사항:</strong><br>
          ${escapeHtml(requestMemo || '별도 요청사항 없음').replace(/\n/g, '<br>')}
        </p>

        <h3>3. 첨부 파일</h3>

        <ul>
          ${attachments.map(file =>
            `<li>${escapeHtml(file.filename)}</li>`
          ).join('')}
        </ul>

        <p style="margin-top:25px;color:#777;font-size:12px;">
          본 메일은 만봉프린트 인쇄풍선 시안 제작 사이트에서 자동 발송되었습니다.
        </p>

      </div>
    `;

    // 7. Resend 이메일 발송 데이터
    const recipients = env.MAIL_TO
      .split(',')
      .map(address => address.trim())
      .filter(Boolean);

    if (
      recipients.length === 0 ||
      recipients.some(address =>
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
      )
    ) {
      return jsonResponse({
        error: '수신 이메일 주소 설정을 확인해 주세요.'
      }, 500);
    }

    const mailData = {
      from: env.MAIL_FROM,
      to: recipients,

      subject:
        `[만봉프린트 시안 접수] ${customerName}`,

      html: html,

      attachments: attachments.map(file => ({
        filename: file.filename,
        content: file.content,
        content_type: file.content_type
      }))
    };

    // 8. Resend API로 메일 발송
    const mailResponse = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',

        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },

        body: JSON.stringify(mailData)
      }
    );

    const result = await mailResponse.json().catch(() => ({}));

    // 9. 이메일 발송 실패 확인
    if (!mailResponse.ok) {

      console.error('Resend 발송 오류:', result);

      return jsonResponse({
        error: '이메일 발송에 실패했습니다. 관리자에게 문의해 주세요.'
      }, 502);
    }

    // 10. 발송 성공
    return jsonResponse({
      success: true,
      message: '이메일 접수가 완료되었습니다.',
      emailId: result.id || null
    });

  } catch (error) {

    // 예상하지 못한 서버 오류
    console.error('시안 접수 서버 오류:', error);

    return jsonResponse({
      error: '서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
    }, 500);

  }

}

