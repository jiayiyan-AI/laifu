from setuptools import setup, find_packages

setup(
    name='email-cli',
    version='0.1.0',
    description='助手邮件收发工具 (Hermes skill: ls/read/send/reply)',
    packages=find_packages(exclude=['tests']),
    python_requires='>=3.10',
    install_requires=[],  # 仅 stdlib
    entry_points={
        'console_scripts': [
            'email=email_cli.cli:main',
        ],
    },
)
