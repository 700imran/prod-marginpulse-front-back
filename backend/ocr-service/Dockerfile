# ═══════════════════════════════════════════════════════════════════════════
#  ocr-service/Dockerfile — small Python Lambda running RapidOCR's real,
#  tested package. Uses AWS's official Python Lambda base image — pip
#  install only, no dnf/apt system packages at all, which is exactly the
#  reliable-install path the tesseract/al2023 attempt was missing.
# ═══════════════════════════════════════════════════════════════════════════
FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
